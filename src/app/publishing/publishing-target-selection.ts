/** 发布工作台恢复当前设备与独立账号；浏览器缓存只作选择提示，必须经最新权限清单验证。 */
import type { PublishingAccount, PublishingPlan } from "@/shared/publishing";
type Target = { agentId: string; instanceId: string };
export type PublishingTargetSelection = Target & { accountId: string };

/** 按登录客户隔离设备选择，不在浏览器保存频道凭据或授权状态。 */
export function publishingTargetStorageKey(username: string) { return "livenest-publishing-target:" + username; }

/** OAuth 返回优先，其次有效的上次选择；已清理、删除或离开当前权限清单的账号不能恢复。 */
export function restorePublishingTarget(targets: Target[], accounts: PublishingAccount[], plans: PublishingPlan[], saved: unknown, returnedAccountId?: string): PublishingTargetSelection | undefined {
  const available = accounts.filter(account => !["cleanup_pending", "deleted"].includes(account.status) && targets.some(target => target.agentId === account.agentId && target.instanceId === account.instanceId));
  const returned = available.find(account => account.id === returnedAccountId);
  if (returned) return { agentId: returned.agentId, instanceId: returned.instanceId, accountId: returned.id };
  const cached = saved && typeof saved === "object" ? saved as Partial<PublishingTargetSelection> : undefined;
  const cachedTarget = targets.find(target => target.agentId === cached?.agentId && target.instanceId === cached?.instanceId);
  if (cachedTarget) {
    const restored = available.find(account => account.id === cached?.accountId && account.agentId === cachedTarget.agentId && account.instanceId === cachedTarget.instanceId);
    const fallback = available.find(account => account.status === "connected" && account.agentId === cachedTarget.agentId && account.instanceId === cachedTarget.instanceId);
    return { agentId: cachedTarget.agentId, instanceId: cachedTarget.instanceId, accountId: restored?.id || (cached?.accountId ? fallback?.id || "" : "") };
  }
  const draft = [...plans].filter(plan => !plan.confirmedAt && !plan.archivedAt).sort((a, b) => b.createdAt - a.createdAt)
    .map(plan => available.find(account => account.id === plan.profile.accountId && account.status === "connected" && account.agentId === plan.profile.agentId && account.instanceId === plan.profile.instanceId)).find(Boolean);
  const first = draft || available.find(account => account.status === "connected");
  if (first) return { agentId: first.agentId, instanceId: first.instanceId, accountId: first.id };
  return targets[0] && { agentId: targets[0].agentId, instanceId: targets[0].instanceId, accountId: "" };
}
