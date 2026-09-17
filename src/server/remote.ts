/** 浏览器到云端的适配边界，目标设备必须显式给出。 */
import "server-only";
import { randomUUID } from "node:crypto";
import { cloudMode } from "@/core/config";
import { AppError } from "@/core/errors";
import { targetSchema, type TaskPayload, type Target } from "@/shared/remote";
import type { Dashboard } from "@/shared/types";
import { initialState } from "@/core/control";
import { listAgents, requireTarget, snapshotFor } from "@/cloud/agents";
import { enqueue, latestControl, operation, rpc } from "@/cloud/tasks";
export { cloudMode, rpc };
/** 云端没有 main 的隐式默认目标；避免两个设备的同名实例串台。 */
export function target(value: unknown): Target { const result = targetSchema.safeParse(value); if (!result.success) throw new AppError("TARGET", "请明确选择直播电脑和 OBS 实例。"); return result.data; }
/** Query 和 JSON 使用相同目标校验。 */
export function queryTarget(request: Request) { const url = new URL(request.url); return target({ agentId: url.searchParams.get("agentId"), instanceId: url.searchParams.get("instanceId") }); }
/** 云端只公开实例、设备名称及在线状态，不接触 Windows 配置。 */
export async function remoteInstances() {
  const agents = await listAgents(); return { agents, instances: agents.filter(a => !a.revoked).flatMap(a => a.instances.map(i => ({ ...i, agentId: a.id, agentName: a.name }))) };
}
/** 过期状态不表示停止推流；保留场次信息但禁用基于旧状态的操作。 */
export async function remoteDashboard(destination: Target): Promise<Dashboard> {
  const agent = await requireTarget(destination.agentId, destination.instanceId);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId); const current = await latestControl(destination);
  const fresh = agent.online && !!snapshot && snapshot.observedAt > Date.now() - 20_000;
  const base: Dashboard = snapshot?.dashboard || { state: initialState(), busy: false, obs: { ready: false, running: false, streaming: null }, youtube: { connected: false }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } };
  const waiting = !!current && ["queued", "delivering", "accepted", "running", "uncertain"].includes(current.status);
  return { ...base, operation: current || base.operation, busy: waiting || base.busy, device: { agentId: agent.id, name: agent.name, online: fresh, lastSeen: agent.lastSeen, observedAt: snapshot?.observedAt }, obs: fresh ? base.obs : { ...base.obs, ready: false, streaming: null, message: agent.online ? "设备状态读取已过期，请检查直播电脑。" : "直播电脑离线；实际推流状态未知，已有直播可能仍在继续。" } };
}
/** 控制接口只持久化完整任务，核心执行在 Agent，不使用 Next after 编排直播。 */
export async function remoteControl(destination: Target, actor: string, payload: Extract<TaskPayload, { kind: "control" }>, requestId: string) {
  return { operation: operation(await enqueue(destination, actor, payload, requestId)) };
}
/** 上传记录仍由目标 Agent 所有，云端补上明确的设备归属。 */
export async function uploadRpc(destination: Target, actor: string, payload: TaskPayload, id?: string): Promise<Record<string, unknown> & { agentId: string }> {
  const result = await rpc<Record<string, unknown>>(destination, actor, payload, id); return { ...result, agentId: destination.agentId };
}
/** 完成校验可耗时很久，返回受理后由 Agent 独立校验；状态请求读取真实进度。 */
export async function remoteFinish(destination: Target, actor: string, uploadId: string) {
  const status = await uploadRpc(destination, actor, { kind: "upload-status", uploadId });
  if (status.status === "complete") return status;
  await enqueue(destination, actor, { kind: "upload-finish", uploadId }, randomUUID());
  return { ...status, status: "verifying" };
}
