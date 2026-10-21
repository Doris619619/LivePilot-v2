/** 上传创建的短期持久准入；Cloud 与投递队列共锁，本机管理员使用独立同等准入。 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { config, requireInstance } from "@/core/config";
import { seal, store, unseal } from "@/core/storage";
import { AppError } from "@/core/errors";
import { agentStore, requireTarget } from "./agents";
import { transaction } from "./store";
import { type UploadInput, type UploadPreparation } from "@/shared/upload-admission";
type Destination = { agentId?: string; instanceId: string };
type Entry = { id: string; actor: string; destination: Destination; hash: string; expiresAt: number; state: "prepared" | "accepted" | "rejected" | "cancelling" | "cancelled" };
export type UploadAdmissionState = { uploadAdmissions?: Entry[] };
const credentialSchema = z.object({ version: z.literal(1), requestId: z.string().uuid(), actor: z.string(), destination: z.object({ agentId: z.string().optional(), instanceId: z.string() }).strict(), hash: z.string(), expiresAt: z.number() }).strict();
const TTL = 5 * 60_000, RETAIN = 8 * 86400_000;
/** 哈希只覆盖已校验的上传元数据，不接受客户端提供的路径。 */
function hash(input: UploadInput) { return createHash("sha256").update(JSON.stringify({ kind: input.kind, filename: input.filename, size: input.size, fingerprint: input.fingerprint })).digest("hex"); }
/** 同一目标身份也必须包含 Cloud 设备，不能把本机与远程实例混用。 */
function same(a: Destination, b: Destination) { return a.agentId === b.agentId && a.instanceId === b.instanceId; }
/** 解密的准入身份必须与已认证成员及请求目标完全匹配；不回显凭据内容。 */
function credential(value: string, actor: string, destination: Destination) {
  let parsed;
  try { parsed = credentialSchema.parse(unseal(value)); } catch { throw new AppError("UPLOAD_ADMISSION", "上传准备凭据无效，请保留原恢复句柄。", 409); }
  if (parsed.actor !== actor || !same(parsed.destination, destination)) throw new AppError("UPLOAD_ADMISSION", "上传准备不属于当前账号和目标。", 403);
  return parsed;
}
/** 提前拒绝确定无效的元数据；本机与 Cloud 使用同一公开文件名规则。 */
export function validatePreparedInput(input: UploadInput) {
  const allowed = input.kind === "videos" ? /\.(mp4|mkv|mov|webm|avi|m4v)$/i : /\.(mp3|wav|flac|aac|m4a|ogg)$/i;
  if (!allowed.test(input.filename) || /[\\/:*?"<>|%\x00-\x1f]/.test(input.filename) || /[. ]$/.test(input.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(input.filename)) throw new AppError("MEDIA", "请选择支持的文件，文件名不能包含路径或特殊字符。");
}
/** 准备只写入身份与准入状态，绝不投递任务或预留 Agent 文件。 */
export async function prepareUploadAdmission(actor: string, destination: Destination, input: UploadInput): Promise<UploadPreparation> {
  validatePreparedInput(input);
  if (!destination.agentId) {
    const max = Number(process.env.LIVEPILOT_UPLOAD_MAX_BYTES || 20 * 1024 ** 3);
    if (!Number.isSafeInteger(max) || max <= 0) throw new AppError("CONFIG", "上传大小限制配置无效。");
    if (input.size > max) throw new AppError("SIZE", "文件为空或超过上传大小限制。", 413);
  }
  if (destination.agentId) await requireTarget(destination.agentId, destination.instanceId); else requireInstance(destination.instanceId);
  const id = randomUUID(); const requestId = id.slice(0, 14) + "8" + id.slice(15), expiresAt = Date.now() + TTL;
  const entry: Entry = { id: requestId, actor, destination, hash: hash(input), expiresAt, state: "prepared" };
  const storage = destination.agentId ? agentStore(destination.agentId) : store(), filename = destination.agentId ? "tasks.json" : "upload-admissions.json";
  await transaction(storage, async () => {
    const queue: UploadAdmissionState & { records?: unknown[] } = await storage.read<UploadAdmissionState>(filename) || { ...(destination.agentId ? { records: [] } : {}) };
    queue.uploadAdmissions = (queue.uploadAdmissions || []).filter(item => item.expiresAt > Date.now() - RETAIN); queue.uploadAdmissions.push(entry); await storage.write(filename, queue);
  }, destination.agentId ? "tasks.lock" : "upload-admissions.lock");
  return { requestId, expiresAt, credential: seal({ version: 1, requestId, actor, destination, hash: entry.hash, expiresAt }) };
}
/** 仅在持有队列锁时消费；受理与队列落盘必须位于同一次原子写入。 */
export function acceptUploadAdmission(queue: UploadAdmissionState, actor: string, destination: Destination, input: UploadInput, id: string, value: string) {
  const claim = credential(value, actor, destination), entry = queue.uploadAdmissions?.find(item => item.id === id);
  if (claim.requestId !== id || claim.hash !== hash(input) || !entry || entry.actor !== actor || !same(entry.destination, destination) || entry.hash !== claim.hash) throw new AppError("UPLOAD_ADMISSION", "上传准备记录尚未确认，请查询原上传，不能重新创建。", 409);
  if (!["prepared", "accepted"].includes(entry.state) || claim.expiresAt <= Date.now() || entry.expiresAt !== claim.expiresAt) throw new AppError("UPLOAD_ADMISSION", "本次上传准备已结束或过期，请确认原上传后再开始下一份。", 409);
  const wasAccepted = entry.state === "accepted"; entry.state = "accepted"; return wasAccepted;
}
/** 明确取消只终结尚未受理的同一准备；已受理或被 GC 的身份绝不猜成未受理。 */
export async function closeUploadAdmission(actor: string, destination: Destination, preparation: UploadPreparation) {
  const claim = credential(preparation.credential, actor, destination);
  if (claim.requestId !== preparation.requestId) throw new AppError("UPLOAD_ADMISSION", "上传准备身份不一致。", 409);
  const storage = destination.agentId ? agentStore(destination.agentId) : store(), filename = destination.agentId ? "tasks.json" : "upload-admissions.json";
  return transaction(storage, async () => {
    const queue = await storage.read<UploadAdmissionState & { records?: { id: string }[] }>(filename), entry = queue?.uploadAdmissions?.find(item => item.id === claim.requestId);
    if (!entry || entry.actor !== actor || !same(entry.destination, destination) || entry.hash !== claim.hash || entry.expiresAt !== claim.expiresAt) throw new AppError("UPLOAD_ADMISSION", "原上传受理结果仍需核对，已保留恢复句柄。", 409);
    if (!["prepared", "rejected"].includes(entry.state)) return { requestId: entry.id, state: "accepted" as const };
    if (queue?.records?.some(record => record.id === entry.id)) throw new AppError("UPLOAD_ADMISSION", "原上传已有投递记录，受理结果仍需核对。", 409);
    entry.state = "rejected"; await storage.write(filename, queue);
    // 入队先写活动再原子写队列；仅 prepared/rejected 且无投递记录证明从未受理，才可收敛此孤儿活动。
    if (destination.agentId) {
      const maintenance = await storage.read<{ activities: Record<string, number> }>("maintenance.json");
      if (maintenance?.activities["upload:" + entry.id]) { delete maintenance.activities["upload:" + entry.id]; await storage.write("maintenance.json", maintenance); }
    }
    return { requestId: entry.id, state: "not-accepted" as const };
  }, destination.agentId ? "tasks.lock" : "upload-admissions.lock");
}
/** 本机管理员先持久确认受理，再执行真实文件操作；之后任何异常均按未知结果保留原句柄。 */
export async function acceptLocalUpload<T>(actor: string, destination: Destination, input: UploadInput, preparation: UploadPreparation, create: () => Promise<T>) {
  requireInstance(destination.instanceId); config(destination.instanceId);
  const storage = store();
  return transaction(storage, async () => {
    const queue = await storage.read<UploadAdmissionState>("upload-admissions.json") || {};
    acceptUploadAdmission(queue, actor, destination, input, preparation.requestId, preparation.credential); await storage.write("upload-admissions.json", queue);
    // 包围真实创建的全部前置文件操作；另一标签取消不能先于此创建返回成功。
    return create();
  }, "upload-admissions.lock");
}
/** 本机新协议取消与创建共锁；确认取消后持久封住迟到创建及相同 ID 的重放。 */
export async function cancelLocalPreparedUpload(actor: string, destination: Destination, id: string, confirmOwner: () => Promise<UploadInput>, cancel: () => Promise<void>) {
  const storage = store();
  return transaction(storage, async () => {
    const queue = await storage.read<UploadAdmissionState>("upload-admissions.json") || {}; let entry = queue.uploadAdmissions?.find(item => item.id === id);
    if (!entry) {
      // 长期分片可续期超过准入保留期：真实本机状态证明归属后补取消墓碑，回执丢失仍可重试。
      const actual = await confirmOwner(); entry = { id, actor, destination, hash: hash(actual), expiresAt: Date.now(), state: "cancelling" };
      (queue.uploadAdmissions ??= []).push(entry);
    }
    if (entry.actor !== actor || !same(entry.destination, destination)) throw new AppError("UPLOAD_ADMISSION", "本机上传归属或受理状态尚未确认，恢复句柄已保留。", 409);
    // 先持久取消意图再删文件；末尾结果写失败也不能让另一标签把同 ID 重新创建。
    entry.state = "cancelling"; await storage.write("upload-admissions.json", queue);
    await cancel(); entry.state = "cancelled"; await storage.write("upload-admissions.json", queue);
  }, "upload-admissions.lock");
}
