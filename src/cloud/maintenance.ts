/** 设备维护与入队共用 tasks.lock，保留状态不明时的阻塞，不强行结束任何任务。 */
import { unseal } from "@/core/storage";
import type { TaskPayload } from "@/shared/remote";
import { AppError } from "@/core/errors";
import { OFFLINE_MS, type AgentSnapshot } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
import { agentStore, extendInstances, listAgents } from "./agents";
import { reconcileUploads } from "./upload-activities";
import type { TaskRecord } from "./tasks";
import { transaction } from "./store";
import { clearOAuthActivity, oauthActivityKey } from "./oauth-activities";
type Maintenance = { token?: string; activities: Record<string, number> };
export type VerifiedIdle = { instanceId: string; observedAt: number; basis: "obs-status" | "process-stopped" };
const finished = new Set(["succeeded", "failed", "interrupted", "expired"]);
/** 本机已认证设备可以提交刚完成的只读检查，只替代坏凭据产生的单目标OBS未知，不替代场次证据。 */
function maintenanceSafe(snapshot: AgentSnapshot | undefined, verifiedIdle?: VerifiedIdle) {
  if (!snapshot || snapshot.observedAt <= Date.now() - OFFLINE_MS || snapshot.observedAt > Date.now() + 5000) return false;
  const d = snapshot.dashboard;
  const verifiedUnknown = d.obs.streaming === null && verifiedIdle?.instanceId === snapshot.instance.id && verifiedIdle.observedAt > Date.now() - OFFLINE_MS && verifiedIdle.observedAt <= Date.now() + 5000 && !d.state.broadcastIntent;
  return !d.busy && (d.obs.streaming === false || verifiedUnknown) && ["idle", "stopped"].includes(d.state.phase) && !d.youtube.error && (!d.state.broadcastId || ["complete", "revoked", "missing"].includes(d.youtube.lifecycle || ""));
}
/** 调用方必须持有 tasks.lock；维护期间拒绝所有新派发。 */
export async function assertAvailable(id: string) {
  if ((await agentStore(id).read<Maintenance>("maintenance.json"))?.token) throw new AppError("MAINTENANCE", "这台电脑正在配置或更新，请等待客户端完成。", 409);
}
/** 登记跨请求授权和上传活动，避免只检查短 RPC 所产生的空档。 */
export async function trackActivity(id: string, kind: string, instance: string, uploadId?: string, taskId?: string) {
  const store = agentStore(id); const state = await store.read<Maintenance>("maintenance.json") || { activities: {} };
  if (kind === "oauth-begin") state.activities[oauthActivityKey(instance, taskId)] = Date.now() + 600_000;
  if (kind === "upload-create" || kind === "upload-chunk") state.activities["upload:" + uploadId] = Date.now() + 7 * 86_400_000;
  await store.write("maintenance.json", state);
}
/** 只在终态成功时关闭活动，失败保持到过期以避免猜测结果。 */
export async function finishActivity(id: string, kind: string, instance: string, uploadId?: string, records: TaskRecord[] = [], cookie?: string) {
  const store = agentStore(id); const state = await store.read<Maintenance>("maintenance.json"); if (!state) return;
  if (kind === "oauth-finish") clearOAuthActivity(state, instance, records, undefined, cookie);
  // 上传只能在完整队列对账后清理，防止与并行创建、分片和校验竞态。
  void uploadId;
  await store.write("maintenance.json", state);
}
/** 与任务队列原子检查：任何直播、未知状态、未完成任务或用户事务都会阻止维护。 */
export async function beginMaintenance(id: string, token: string, verifiedIdle?: VerifiedIdle) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("INPUT", "维护凭据无效。");
  if (verifiedIdle && (!/^[a-z][a-z0-9_]{0,31}$/.test(verifiedIdle.instanceId) || !["obs-status", "process-stopped"].includes(verifiedIdle.basis) || !Number.isFinite(verifiedIdle.observedAt) || verifiedIdle.observedAt <= Date.now() - OFFLINE_MS || verifiedIdle.observedAt > Date.now() + 5000)) throw new AppError("MAINTENANCE_PROOF", "本机空闲检查已失效，请在原客户端重新检查。", 409);
  const store = agentStore(id);
  return transaction(store, async () => {
    const queue = await store.read<{ records: TaskRecord[] }>("tasks.json");
    await reconcileUploads(id, queue?.records || []);
    const previous = await store.read<Maintenance>("maintenance.json") || { activities: {} };
    if (previous.token === token) return { token };
    if (previous.token) throw new AppError("MAINTENANCE", "设备已有维护操作，请从原客户端恢复。", 409);
    const publishing = await store.read<{ busy: boolean; at: number }>("publishing-runtime.json");
    if (publishing?.busy) throw new AppError("BUSY", "普通视频正在上传或核对，请在发布队列暂停并等待安全检查点后再维护。", 409);
    const agent = (await listAgents()).find(a => a.id === id); const beat = await store.read<{ snapshots: AgentSnapshot[] }>("heartbeat.json");
    if (verifiedIdle && !agent?.instances.some(instance => instance.id === verifiedIdle.instanceId)) throw new AppError("MAINTENANCE_PROOF", "本机空闲检查与当前实例不一致。", 409);
    const pending = queue?.records.some(r => !finished.has(r.status) && !(r.status === "queued" && r.expiresAt < Date.now()));
    const safe = agent?.online && agent.instances.every(i => maintenanceSafe(beat?.snapshots.find(s => s.instance.id === i.id), verifiedIdle));
    const uploads = Object.keys(previous.activities).filter(k => k.startsWith("upload:"));
    if (uploads.length) throw new AppError("BUSY", "仍有 " + uploads.length + " 个上传未确认结束，请在网页素材上传中查询或取消（" + uploads.map(k=>{const entry=queue?.records.find(r=>{if(r.kind!=="upload-create")return false;const p=unseal<TaskPayload>(r.payload);return p.kind==="upload-create"&&p.uploadId===k.slice(7);});if(!entry)return "待确认文件（请在网页找回未完成上传）";const p=unseal<TaskPayload>(entry.payload);return (agent?.instances.find(i=>i.id===entry.instanceId)?.name||entry.instanceId)+" · "+(p.kind==="upload-create"?p.input.filename:"待确认文件");}).join("、") + "）。", 409);
    if (pending) throw new AppError("BUSY", "设备仍有执行中或结果待确认的任务，请等待 Agent 回报，不能强制结束。", 409);
    if (Object.values(previous.activities).some(t => t > Date.now())) throw new AppError("BUSY", "频道授权尚未结束，请返回发起授权的 OBS 卡片完成或取消；最迟等待至 "+new Date(Math.max(...Object.values(previous.activities))).toISOString()+" 后重新检查。", 409);
    if (!safe) throw new AppError("BUSY", "尚未确认空闲："+(agent?.instances.filter(i=>!maintenanceSafe(beat?.snapshots.find(s=>s.instance.id===i.id), verifiedIdle)).map(i=>i.name).join("、") || agent?.name || "此电脑")+"。请到网页对应实例查询推流和频道状态；未知状态不能强制结束。", 409);
    await store.write("maintenance.json", { token, activities: {} }); return { token };
  }, "tasks.lock");
}
/** 原设备持有恢复凭据才能修改清单或释放维护；不因超时自动放行远程开播。 */
export async function changeMaintenance(id: string, token: string, instances?: InstanceDescriptor[], recovering = false) {
  const store = agentStore(id);
  return transaction(store, async () => {
    const state = await store.read<Maintenance>("maintenance.json");
    // 未成功取得锁或释放响应丢失后可以恢复会话；不改变实例或任何活动。
    if (!state?.token && (recovering || !instances)) return { ok: true };
    if (!state?.token || state.token !== token) throw new AppError("MAINTENANCE", "维护凭据不匹配，请从原客户端恢复。", 409);
    if (instances) return extendInstances(id, instances);
    await store.write("maintenance.json", { activities: {} }); return { ok: true };
  }, "tasks.lock");
}
