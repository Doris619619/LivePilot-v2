/** YouTube生命周期准入：仅有效OAuth短任务和原清理请求可跨越非connected状态，正常业务仍需已连接账号。 */
import { unseal } from "@/core/storage";
import { AppError } from "@/core/errors";
import type { YouTubeAdmit } from "@/shared/youtube-usage";
import type { TaskPayload } from "@/shared/remote";
import { requireTarget, agentStore } from "./agents";
import { requirePublishingAccount, requirePublishingAccountOwner, publishingAccountCleanups } from "./publishing-accounts";
import type { TaskRecord } from "./tasks";

/** 首次/恢复授权只接受已经下发、未过期且未取消的原账号OAuth-finish任务，不信任设备自报purpose。 */
async function assertOAuthTask(agentId: string, input: YouTubeAdmit, owner?: string) {
  if (!input.operationId || input.jobId || input.purpose !== "authorization" || input.trigger !== "oauth-finish" || !["oauth.token", "channels.list"].includes(input.method)) throw new AppError("FORBIDDEN", "频道连接请求必须对应有效授权任务。", 403);
  const records = (await agentStore(agentId).read<{ records: TaskRecord[] }>("tasks.json"))?.records;
  const task = records?.find(record => record.id === input.operationId && record.agentId === agentId && record.instanceId === input.instanceId && record.kind === "publishing-account-oauth-finish" && ["delivering", "accepted", "running", "uncertain"].includes(record.status) && record.expiresAt >= Date.now());
  if (!task || owner && task.customer !== owner) throw new AppError("FORBIDDEN", "频道连接任务已结束、过期或不属于当前设备。", 403);
  const payload = unseal<TaskPayload>(task.payload);
  if (payload.kind !== "publishing-account-oauth-finish" || payload.accountId !== input.accountId || payload.cancelled) throw new AppError("FORBIDDEN", "频道连接任务与发布账号不一致。", 403);
}
/** 撤销只匹配原pending清理请求；deadline是既有清理目标，离线超过它仍允许原请求继续撤销。 */
async function assertCleanupRequest(agentId: string, input: YouTubeAdmit, owner?: string) {
  if (!input.operationId || input.jobId || input.purpose !== "authorization") throw new AppError("FORBIDDEN", "撤销授权必须对应原清理请求。", 403);
  if (input.accountId) {
    const account = await requirePublishingAccountOwner(agentId, input.instanceId, input.accountId);
    const cleanup = (await publishingAccountCleanups(agentId)).find(record => record.id === input.operationId && record.accountId === input.accountId && record.instanceId === input.instanceId && record.state === "pending");
    if (account.status !== "cleanup_pending" || !cleanup || owner && cleanup.owner !== owner) throw new AppError("FORBIDDEN", "此发布账号没有匹配的待完成清理请求。", 403);
    return;
  }
  const { publishingStore } = await import("./publishing");
  const state = await publishingStore().read<{ cleanups?: { id: string; agentId: string; instanceId: string; owner: string; state: string }[] }>("state.json");
  if (!state?.cleanups?.some(record => record.id === input.operationId && record.agentId === agentId && record.instanceId === input.instanceId && record.state === "pending" && (!owner || record.owner === owner))) throw new AppError("FORBIDDEN", "此实例没有匹配的待完成清理请求。", 403);
}
/** 返回已验证设备；例外只允许授权建立和撤销所需方法，绝不解除账号状态或放开上传。 */
export async function assertYouTubeLifecycleContext(agentId: string, input: YouTubeAdmit) {
  const machine = await requireTarget(agentId, input.instanceId);
  if (input.method === "oauth.revoke") { await assertCleanupRequest(agentId, input, machine.owner); return machine; }
  if (input.accountId) {
    const account = await requirePublishingAccountOwner(agentId, input.instanceId, input.accountId);
    if (account.status !== "connected" && !["cleanup_pending", "deleted"].includes(account.status)) await assertOAuthTask(agentId, input, machine.owner);
    else await requirePublishingAccount(agentId, input.instanceId, input.accountId);
  } else {
    const { publishingStore } = await import("./publishing");
    const state = await publishingStore().read<{ cleanups?: { agentId: string; instanceId: string; state: string }[] }>("state.json");
    if (state?.cleanups?.some(record => record.agentId === agentId && record.instanceId === input.instanceId && record.state === "pending")) throw new AppError("CLEANUP", "此实例正在清理授权，只能继续原撤销请求。", 409);
  }
  return machine;
}
