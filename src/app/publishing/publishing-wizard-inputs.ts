/** 发布向导输入快照：过期异步结果不能替换当前选择，确认只接受同一素材、配置和时间。 */
import type { PackageBatch, PublishingPlan, PublishingPlanRule, PublishingProfile } from "@/shared/publishing";
import type { PublishingTarget } from "./profile-editor";

export type PublishingWizardInputs = { target: PublishingTarget; batch?: PackageBatch; profile?: PublishingProfile; rule: PublishingPlanRule; excluded: string[] };
/** 不包含计划修订：服务端保存同一输入返回新修订时，仍属于本次请求。 */
export function publishingInputKey({ target, batch, profile, rule, excluded }: PublishingWizardInputs) {
  return JSON.stringify({ target: [target.agentId, target.instanceId, target.accountId, target.channelId], batch: batch && [batch.id, batch.version], profile: profile && [profile.id, profile.revision, profile.accountId, profile.scheduled], rule, excluded: [...excluded].sort() });
}
/** 配置身份由不可变修订固定，所选目标和批次版本也必须一致；旧排期不能代替新选择确认。 */
export function publishingPlanMatchesInputs(plan: PublishingPlan | undefined, { target, batch, profile, rule, excluded }: PublishingWizardInputs) {
  return !!plan && !plan.archivedAt && !!batch && !!profile && plan.profile.agentId === target.agentId && plan.profile.instanceId === target.instanceId && plan.profile.accountId === target.accountId && (!target.channelId || plan.profile.channelId === target.channelId) && plan.batch.id === batch.id && plan.batch.version === batch.version && plan.profile.id === profile.id && plan.profile.revision === profile.revision && plan.profile.accountId === profile.accountId && plan.profile.scheduled === profile.scheduled && JSON.stringify(plan.rule) === JSON.stringify(rule) && plan.items.every(item => item.excluded === excluded.includes(item.packageId));
}
