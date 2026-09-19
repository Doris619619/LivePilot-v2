/** 持久化设备投递记录；超时不是执行失败，重连不生成新任务。 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { seal, unseal } from "@/core/storage";
import { AppError, sleep } from "@/core/errors";
import { ACCEPT_MS, PROTOCOL, taskPayloadSchema, type RemoteTask, type TaskPayload, type TaskReport, type Target, type DeliveryState } from "@/shared/remote";
import { operationSchema, uploadStatusSchema } from "@/shared/remote-validation";
import type { CommandStatus } from "@/shared/types";
import { requireTarget, agentStore } from "./agents";
import { transaction } from "./store";
import { reconcileUploads, uploadId, type MaintenanceState } from "./upload-activities";
import { assertAvailable, trackActivity, finishActivity } from "./maintenance";
export type TaskRecord = Target & { id: string; actor: string; kind: TaskPayload["kind"]; action: string; fingerprint: string; payload: string; expiresAt: number; status: DeliveryState; updatedAt: number; createdAt: number; result?: string; message?: string; httpStatus?: number; uploadStable?: boolean };
type Queue = { records: TaskRecord[] };
export const terminal = (status: DeliveryState) => ["succeeded", "failed", "interrupted", "expired"].includes(status);
/** 控制和授权共享实例互斥，上传有独立任务并发。 */
const exclusive = (kind: TaskPayload["kind"]) => kind === "control" || kind.startsWith("oauth-");
/** 未送达可过期；已送达必须由 Agent 回报是否接收，不能猜成失败。 */
function expire(record: TaskRecord) {
  if (record.expiresAt >= Date.now()) return;
  if (record.status === "queued") { record.status = "expired"; record.message = "设备未在一分钟内接收，任务已过期。"; }
  else if (record.status === "delivering") { record.status = "uncertain"; record.message = "设备接收结果待核对，请等待重连；没有重新下发新的控制任务。"; }
}
/** 对业务输入建立稳定指纹，阻止相同 ID 被用于其他目标、操作者或动作。 */
function fingerprint(target: Target, actor: string, payload: TaskPayload) { return createHash("sha256").update(JSON.stringify({ ...target, actor, payload })).digest("hex"); }
/** 持久化后才返回受理；重复请求即便设备离线也能读取原结果。 */
export async function enqueue(target: Target, actor: string, payload: TaskPayload, id: string = randomUUID()) {
  payload = taskPayloadSchema.parse(payload);
  const store = agentStore(target.agentId); const hash = fingerprint(target, actor, payload);
  return transaction(store, async () => {
    const queue = await store.read<Queue>("tasks.json") || { records: [] };
    queue.records.forEach(expire);
    const previous = queue.records.find(r => r.id === id);
    if (previous) { if (previous.fingerprint !== hash) throw new AppError("REQUEST", "请求标识已用于其他操作。", 409); await store.write("tasks.json", queue); return previous; }
    await requireTarget(target.agentId, target.instanceId, true);
    await assertAvailable(target.agentId);
    if ("uploadId" in payload) {
      const owner = queue.records.find(r => uploadId(r) === payload.uploadId && (r.kind === "upload-create" || (r.kind === "upload-status" && r.status === "succeeded")));
      if (owner && (owner.actor !== actor || owner.instanceId !== target.instanceId)) throw new AppError("UPLOAD", "上传记录不存在或不属于当前账号和实例。", 404);
    }
    if (payload.kind === "upload-cancel" && !queue.records.some(r => uploadId(r) === payload.uploadId && r.actor === actor && r.instanceId === target.instanceId && (r.kind === "upload-create" || (r.kind === "upload-status" && r.status === "succeeded")))) throw new AppError("UPLOAD", "上传归属尚未确认，请先在原账号和目标实例查询上传。", 409);
    if (payload.kind === "upload-cancel" && queue.records.some(r => uploadId(r) === payload.uploadId && r.kind !== "upload-status" && !terminal(r.status))) throw new AppError("BUSY", "该上传仍有执行中或待确认的任务，请先查询状态，确认后再取消。", 409);
    if (exclusive(payload.kind) && queue.records.some(r => r.instanceId === target.instanceId && exclusive(r.kind) && !terminal(r.status))) throw new AppError("BUSY", "该实例仍有未完成或待核对任务，请等待设备回报。", 409);
    const activities = (await store.read<MaintenanceState>("maintenance.json"))?.activities || {};
    queue.records = queue.records.filter(r => r.kind === "control" || !terminal(r.status) || r.updatedAt > Date.now() - 600_000 || !!activities["upload:" + uploadId(r)]);
    const record: TaskRecord = { ...target, id, actor, kind: payload.kind, action: payload.kind === "control" ? payload.input.action : payload.kind, fingerprint: hash, payload: seal(payload), status: "queued", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + ACCEPT_MS };
    if (payload.kind === "upload-status") record.uploadStable = !queue.records.some(r => uploadId(r) === payload.uploadId && r.kind !== "upload-status" && !terminal(r.status));
    await trackActivity(target.agentId, payload.kind, target.instanceId, "uploadId" in payload ? payload.uploadId : undefined);
    queue.records.push(record); await store.write("tasks.json", queue); return record;
  }, "tasks.lock");
}
/** 设备轮询标记已投递后返回；超期已投递任务仍返回，供本机日志确认。 */
export async function pollTasks(agentId: string): Promise<RemoteTask[]> {
  const store = agentStore(agentId);
  return transaction(store, async () => {
    const queue = await store.read<Queue>("tasks.json") || { records: [] }; queue.records.forEach(expire);
    const records = queue.records.filter(r => !terminal(r.status)).slice(0, 32);
    for (const r of records) if (r.status === "queued") { r.status = "delivering"; r.updatedAt = Date.now(); }
    await store.write("tasks.json", queue); await reconcileUploads(agentId, queue.records);
    return records.map(r => ({ protocol: PROTOCOL, id: r.id, agentId, instanceId: r.instanceId, actor: r.actor, expiresAt: r.expiresAt, payload: unseal<TaskPayload>(r.payload) }));
  }, "tasks.lock");
}
/** 只接受任务类型对应的公开输出；授权 Cookie 仅在加密结果中短暂保存。 */
function resultFor(record: TaskRecord, value: unknown) {
  if (record.kind === "control") return operationSchema.parse(value);
  if (record.kind === "oauth-begin") {
    const result = z.object({ cookie: z.string().regex(/^[a-f0-9]{64}$/), url: z.string().max(8192) }).parse(value);
    if (new URL(result.url).origin !== "https://accounts.google.com") throw new AppError("OAUTH", "设备返回了无效授权地址。", 502);
    return result;
  }
  if (record.kind === "oauth-finish" || record.kind === "upload-cancel") return { ok: true };
  const result = uploadStatusSchema.parse(value);
  if (result.instanceId !== record.instanceId || result.id !== uploadId(record)) throw new AppError("INSTANCE", "设备上报了其他实例的上传。", 403);
  return result;
}
/** 回报只能更新该设备的记录；终态不会被迟到的 accepted/running 覆盖。 */
export async function reportTasks(agentId: string, reports: TaskReport[]) {
  const store = agentStore(agentId);
  const result = await transaction(store, async () => {
    const queue = await store.read<Queue>("tasks.json") || { records: [] }; const acknowledged: string[] = [];
    for (const report of reports) {
      const record = queue.records.find(r => r.id === report.id); if (!record) { acknowledged.push(report.id); continue; }
      if (record.status === "queued") throw new AppError("TASK", "任务尚未派发。", 409);
      if (!terminal(record.status)) {
        if (!(record.status === "running" && report.status === "accepted")) record.status = report.status;
        record.updatedAt = Date.now(); record.message = report.error; record.httpStatus = report.httpStatus;
        if (report.status === "succeeded") {
          record.result = seal(resultFor(record, report.result)); const p = unseal<TaskPayload>(record.payload);
          await finishActivity(agentId, p.kind, record.instanceId, "uploadId" in p ? p.uploadId : undefined);
        }
      }
      if (terminal(record.status)) acknowledged.push(report.id);
    }
    await store.write("tasks.json", queue); await reconcileUploads(agentId, queue.records); return acknowledged;
  }, "tasks.lock");
  // 失败创建可能已落盘但响应丢失，使用旧协议 upload-status 对账，不能直接删除活动。
  for (const report of reports.filter(r => ["failed", "interrupted"].includes(r.status))) {
    const record = await readTask(agentId, report.id);
    if (record?.kind === "upload-create" || record?.kind === "upload-finish" || record?.kind === "upload-cancel") {
      const id = uploadId(record)!;
      await enqueue({ agentId, instanceId: record.instanceId }, record.actor, { kind: "upload-status", uploadId: id }, reconciliationId(record.id)).catch(() => {});
    }
  }
  return result;
}
/** 从原任务产生稳定的查询 ID，重复心跳不会不断新建对账任务。 */
function reconciliationId(id: string) {
  const h = createHash("sha256").update("upload-reconcile:" + id).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-8" + h.slice(17, 20) + "-" + h.slice(20, 32);
}
/** 获取单个任务；同名任务在不同设备目录中完全隔离。 */
export async function readTask(agentId: string, id: string) { const result = (await agentStore(agentId).read<Queue>("tasks.json"))?.records.find(r => r.id === id); if (result) expire(result); return result; }
/** 展示控制操作，不把 OAuth 事务和上传内部任务显示成直播操作。 */
export async function latestControl(target: Target): Promise<CommandStatus | undefined> {
  const records = (await agentStore(target.agentId).read<Queue>("tasks.json"))?.records.filter(r => r.instanceId === target.instanceId && r.kind === "control") || [];
  const record = records.at(-1); if (!record) return; expire(record); return operation(record);
}
/** 任务公开视图严格排除 payload/result。 */
export function operation(record: TaskRecord): CommandStatus { return { id: record.id, actor: record.actor, action: record.action, status: record.status, updatedAt: new Date(record.updatedAt).toISOString(), message: record.message }; }
/** 短 RPC 等待落盘结果；超时保留任务供核对，绝不声称执行失败。 */
export async function rpc<T>(target: Target, actor: string, payload: TaskPayload, id?: string): Promise<T> {
  const task = await enqueue(target, actor, payload, id); const deadline = Date.now() + 45_000;
  do {
    const record = await readTask(target.agentId, task.id);
    if (record?.status === "succeeded") return unseal<T>(record.result!);
    if (record && terminal(record.status)) throw new AppError("AGENT_TASK", record.message || "设备未完成操作，请检查直播电脑。", record.httpStatus || 409);
    await sleep(200);
  } while (Date.now() < deadline);
  throw new AppError("AGENT_TIMEOUT", "设备结果尚未确认，请重新连接后查询；没有自动重复控制任务。", 504);
}
