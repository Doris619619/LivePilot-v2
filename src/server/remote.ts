/** 浏览器到云端的适配边界，目标设备必须显式给出。 */
import "server-only";
import type { Member } from "./access";
import { randomUUID } from "node:crypto";
import { cloudMode } from "@/core/config";
import { AppError } from "@/core/errors";
import { targetSchema, type AgentSnapshot, type TaskPayload, type Target } from "@/shared/remote";
import type { Dashboard } from "@/shared/types";
import { usesChatConversation } from "@/shared/live-chat";
import { initialState } from "@/core/control";
import { listAgents, requireTarget, snapshotFor, problemsFor } from "@/cloud/agents";
import { enqueue, latestControl, operation, rpc } from "@/cloud/tasks";
export { cloudMode, rpc };
/** 云端没有 main 的隐式默认目标；避免两个设备的同名实例串台。 */
export function target(value: unknown): Target { const result = targetSchema.safeParse(value); if (!result.success) throw new AppError("TARGET", "请明确选择直播电脑和 OBS 实例。"); return result.data; }
/** Query 和 JSON 使用相同目标校验。 */
export function queryTarget(request: Request) { const url = new URL(request.url); return target({ agentId: url.searchParams.get("agentId"), instanceId: url.searchParams.get("instanceId") }); }
/** 云端只公开实例、设备名称及在线状态，不接触 Windows 配置。 */
export async function remoteInstances(user?: Member) {
  const visible = (await listAgents()).filter(a => !user || user.role === "admin" || a.owner === user.username);
  const active = new Set(visible.filter(a => !a.revoked && !a.pairedTo).map(a => a.id));
  // 已消费邀请仅用于确认原配对结果；目标删除后一起隐藏，不显示为电脑卡片。
  const agents = visible.filter(a => !a.revoked || (a.pairedTo && active.has(a.pairedTo)));
  return { agents, instances: agents.filter(a => !a.revoked).flatMap(a => a.instances.map(i => ({ ...i, agentId: a.id, agentName: a.name }))) };
}
/** 过期状态不表示停止推流；保留场次信息但禁用基于旧状态的操作。 */
export async function remoteDashboard(destination: Target): Promise<Dashboard> {
  const agent = await requireTarget(destination.agentId, destination.instanceId);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId); const current = await latestControl(destination);
  const fresh = agent.online && !!snapshot && snapshot.observedAt > Date.now() - 20_000 && snapshot.observedAt <= Date.now() + 5_000;
  const base: Dashboard = snapshot?.dashboard || { state: initialState(), busy: false, obs: { ready: false, running: false, streaming: null }, youtube: { connected: false }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "public", madeForKids: false } };
  const waiting = !!current && ["queued", "delivering", "accepted", "running", "uncertain"].includes(current.status);
  return { ...base, problems: [...(base.problems || []), ...await problemsFor(destination.agentId,destination.instanceId)], operation: current || base.operation, busy: waiting || base.busy, device: { agentId: agent.id, name: agent.name, online: fresh, lastSeen: agent.lastSeen, observedAt: snapshot?.observedAt }, obs: fresh ? base.obs : { ...base.obs, ready: false, streaming: null, message: agent.online ? "设备状态读取已过期，请检查直播电脑。" : "直播电脑离线；实际推流状态未知，已有直播可能仍在继续。" } };
}
/** 人工平台核对只投递给明确声明支持且状态新鲜的Agent；返回本次真实结果而不等待心跳缓存。 */
export async function checkRemoteYouTube(destination: Target, actor: string): Promise<Dashboard> {
  await requireTarget(destination.agentId, destination.instanceId, true);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId);
  if (!snapshot?.dashboard.configuration.youtubeRefresh) throw new AppError("CONFIG", "请升级这台直播电脑的 Agent 后重新核对平台，或到 YouTube Studio 手动核对。", 409);
  if (snapshot.observedAt <= Date.now() - 20_000 || snapshot.observedAt > Date.now() + 5000) throw new AppError("AGENT_STALE", "设备状态已过期，请等待直播电脑重新连接后核对平台。", 409);
  const checked = await rpc<AgentSnapshot>(destination, actor, { kind: "broadcast-read" });
  if (checked.observedAt <= Date.now() - 20_000 || checked.observedAt > Date.now() + 5000) throw new AppError("AGENT_STALE", "本次平台核对结果已过期，请重新核对。", 409);
  const result = checked.dashboard;
  const latest = await remoteDashboard(destination);
  if (latest.operation && Date.parse(latest.operation.updatedAt) >= checked.observedAt && (latest.operation.id !== result.operation?.id || latest.operation.status !== result.operation?.status)) throw new AppError("STATE_CHANGED", "平台核对后又有控制操作，已丢弃旧结果。请刷新当前场次状态。", 409);
  return { ...result, operation: latest.operation, busy: latest.busy || result.busy, device: { ...latest.device!, online: true, observedAt: checked.observedAt } };
}
/** 旧 Agent 不识别新任务时提前拒绝，避免把无法解析的任务塞进设备队列。 */
export async function requireBroadcastDetails(destination: Target) {
  await requireTarget(destination.agentId, destination.instanceId, true);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId);
  if (!snapshot?.dashboard.configuration.broadcastDetails) throw new AppError("CONFIG", "请先升级这台直播电脑的 Agent，再设置直播详情。", 409);
}
/** 只向拥有新聊天能力和有效当前快照的 Agent 投递，旧版本仍可正常开停播。 */
export async function requireLiveChat(destination: Target) {
  await requireTarget(destination.agentId, destination.instanceId, true);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId);
  if (!snapshot?.dashboard.configuration.liveChat) throw new AppError("CONFIG", "请先升级这台直播电脑的 Agent，再使用 AI 观众互动。", 409);
  if (snapshot.observedAt <= Date.now() - 20_000 || snapshot.observedAt > Date.now() + 5_000) throw new AppError("AGENT_STALE", "设备状态已过期，请等待直播电脑重新连接后操作 AI 互动。", 409);
}
/** 新人设、接话参数与试聊只投递到明确声明能力的 Agent，避免旧 strict schema 拒绝整条任务。 */
export async function requireChatConversation(destination: Target) {
  await requireLiveChat(destination);
  const snapshot = await snapshotFor(destination.agentId, destination.instanceId);
  if (!snapshot?.dashboard.configuration.chatConversation) throw new AppError("CONFIG", "请升级直播电脑的 Agent，以使用新人设、接话策略和试聊。", 409);
}
/** 控制接口只持久化完整任务，核心执行在 Agent，不使用 Next after 编排直播。 */
export async function remoteControl(destination: Target, actor: string, payload: Extract<TaskPayload, { kind: "control" }>, requestId: string) {
  if (payload.input.action === "start" && payload.input.broadcast) await requireBroadcastDetails(destination);
  if (payload.input.action === "start" && payload.input.broadcast?.liveChat) {
    if (usesChatConversation(payload.input.broadcast.liveChat)) await requireChatConversation(destination);
    const snapshot = await snapshotFor(destination.agentId, destination.instanceId);
    if (!snapshot?.dashboard.configuration.liveChatSelection) throw new AppError("CONFIG", "请更新直播电脑的 LiveNest 客户端，以便按本场配置启动观众互动。", 409);
  }
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
