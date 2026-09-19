/** 设备维护与入队共用 tasks.lock，保留状态不明时的阻塞，不强行结束任何任务。 */
import { AppError } from "@/core/errors";
import { OFFLINE_MS, type AgentSnapshot } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
import { agentStore, extendInstances, listAgents } from "./agents";
import { transaction } from "./store";
type Maintenance = { token?: string; activities: Record<string, number> };
const finished = new Set(["succeeded", "failed", "interrupted", "expired"]);
/** 调用方必须持有 tasks.lock；维护期间拒绝所有新派发。 */
export async function assertAvailable(id: string) {
  if ((await agentStore(id).read<Maintenance>("maintenance.json"))?.token) throw new AppError("MAINTENANCE", "这台电脑正在配置或更新，请等待客户端完成。", 409);
}
/** 登记跨请求授权和上传活动，避免只检查短 RPC 所产生的空档。 */
export async function trackActivity(id: string, kind: string, instance: string, uploadId?: string) {
  const store = agentStore(id); const state = await store.read<Maintenance>("maintenance.json") || { activities: {} };
  if (kind === "oauth-begin") state.activities["oauth:" + instance] = Date.now() + 600_000;
  if (kind === "upload-create" || kind === "upload-chunk") state.activities["upload:" + uploadId] = Date.now() + 7 * 86_400_000;
  await store.write("maintenance.json", state);
}
/** 只在终态成功时关闭活动，失败保持到过期以避免猜测结果。 */
export async function finishActivity(id: string, kind: string, instance: string, uploadId?: string) {
  const store = agentStore(id); const state = await store.read<Maintenance>("maintenance.json"); if (!state) return;
  if (kind === "oauth-finish") delete state.activities["oauth:" + instance];
  if (kind === "upload-finish" || kind === "upload-cancel") delete state.activities["upload:" + uploadId];
  await store.write("maintenance.json", state);
}
/** 与任务队列原子检查：任何直播、未知状态、未完成任务或用户事务都会阻止维护。 */
export async function beginMaintenance(id: string, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("INPUT", "维护凭据无效。");
  const store = agentStore(id);
  return transaction(store, async () => {
    const previous = await store.read<Maintenance>("maintenance.json") || { activities: {} };
    if (previous.token === token) return { token };
    if (previous.token) throw new AppError("MAINTENANCE", "设备已有维护操作，请从原客户端恢复。", 409);
    const agent = (await listAgents()).find(a => a.id === id); const beat = await store.read<{ snapshots: AgentSnapshot[] }>("heartbeat.json");
    const queue = await store.read<{ records: { status: string; expiresAt: number }[] }>("tasks.json");
    const pending = queue?.records.some(r => !finished.has(r.status) && !(r.status === "queued" && r.expiresAt < Date.now()));
    const safe = agent?.online && agent.instances.every(i => {
      const s = beat?.snapshots.find(s => s.instance.id === i.id); const d = s?.dashboard;
      return s && s.observedAt > Date.now() - OFFLINE_MS && d && !d.busy && d.obs.streaming === false && ["idle", "stopped"].includes(d.state.phase) && !d.youtube.error && (!d.state.broadcastId || ["complete", "revoked", "missing"].includes(d.youtube.lifecycle || ""));
    });
    if (!safe || pending || Object.values(previous.activities).some(t => t > Date.now())) throw new AppError("BUSY", "请结束所有直播、上传和授权，并等待状态确认后重试。", 409);
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
