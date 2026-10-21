/** YouTube 日志历史归属只验证持久身份，不把事后补报误当成新的上游调用授权。 */
import { AppError } from "@/core/errors";
import type { YouTubeAdmit, YouTubeUsageEvent } from "@/shared/youtube-usage";
import { ownsPublishingAccountHistory } from "./publishing-accounts";
import { cloudStore } from "./store";
type Registry = { agents: { id: string; revoked: boolean; instances: { id: string }[]; retiredInstanceIds?: string[] }[] };
/** 只允许当前认证设备的日志；活跃或已退休实例均是历史证据，不提供任何联网权限。 */
export async function youtubeHistoryInstances(agentId: string) {
  const agent = (await cloudStore().read<Registry>("agents.json"))?.agents.find(value => value.id === agentId && !value.revoked);
  if (!agent) throw new AppError("AGENT_AUTH", "设备凭据无效或已撤销。", 401);
  return new Set([...agent.instances.map(instance => instance.id), ...(agent.retiredInstanceIds || [])]);
}
/** 无准入凭据的决策只接受本设备历史路由；未知/跨设备账号返回缺口，存储错误仍向上传播。 */
export async function ownsYouTubeDecision(agentId: string, event: YouTubeUsageEvent, instances: Set<string>) {
  if (!event.decision) return false;
  // 发布账号永久保留原路由；删除或停止关联后也可证明曾属于该设备实例。
  if (event.accountId) return ownsPublishingAccountHistory(agentId, event.instanceId, event.accountId);
  return instances.has(event.instanceId);
}
/** 原调用的全部业务范围必须匹配，不能借别人的method或控制/发布身份写结果、计数或熔断。 */
export function matchesYouTubeReceipt(input: YouTubeAdmit, event: YouTubeUsageEvent) {
  return input.attemptId === event.attemptId && input.instanceId === event.instanceId && input.accountId === event.accountId && input.method === event.method && input.purpose === event.purpose && input.trigger === event.trigger && input.jobId === event.jobId && input.operationId === event.operationId && (input.retryCount || 0) === (event.retryCount || 0);
}
/** 永久无法验真的记录只保留本设备的缺口证明，移除不可验证的账号、任务、调用关联与状态。 */
export function youtubeHistoryGap(event: YouTubeUsageEvent, now: number): YouTubeUsageEvent {
  return { eventId: event.eventId, bootId: event.bootId, sequence: event.sequence, at: Math.min(event.at, now), instanceId: "main", method: "channels.list", purpose: "background", trigger: "unknown", transport: "rest", kind: "decision", decision: "dropped", droppedEvents: (event.droppedEvents || 0) + (event.kind === "decision" ? event.count || 1 : 1) };
}
