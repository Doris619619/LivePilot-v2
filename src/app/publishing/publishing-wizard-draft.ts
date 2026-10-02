/** 向导缓存恢复：明确的新批次选择优先于旧 Cloud 草稿，已保存计划仍按固定身份恢复。 */
import { planRuleSchema, type PublishingPlan, type PublishingPlanRule } from "@/shared/publishing";

export type PublishingDraft = { planId: string; batchId: string; profileId: string; rule?: PublishingPlanRule; excluded: string[]; step: number; newDraft: boolean };
type Target = { agentId: string; instanceId: string; accountId?: string };

/** 缓存只恢复非敏感输入；时区规则与排除 ID 必须通过现有协议校验，不恢复素材有效性。 */
export function parsePublishingDraft(value: unknown): PublishingDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>; const rule = planRuleSchema.safeParse(record.rule);
  return {
    planId: typeof record.planId === "string" ? record.planId : "", batchId: typeof record.batchId === "string" ? record.batchId : "", profileId: typeof record.profileId === "string" ? record.profileId : "",
    rule: rule.success ? rule.data : undefined,
    excluded: Array.isArray(record.excluded) ? record.excluded.filter((id): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) : [],
    step: typeof record.step === "number" && [1, 2, 3, 4].includes(record.step) ? record.step : 1,
    newDraft: record.newDraft === true,
  };
}

/** 兼容旧缓存的无 planId 批次选择；下一批尚未扫描时也用显式标记保护空选择。 */
export function hasNewPublishingDraft(cached?: PublishingDraft) {
  return !!cached && !cached.planId && (cached.newDraft || !!cached.batchId);
}

/** 固定同设备/实例/账号的计划优先；用户明确选择新批次后刷新不能被旧未确认计划覆盖。 */
export function restorePublishingPlan(plans: PublishingPlan[], target: Target, cached?: PublishingDraft): PublishingPlan | undefined {
  const allowed = plans.filter(plan => !plan.archivedAt && plan.profile.agentId === target.agentId && plan.profile.instanceId === target.instanceId && plan.profile.accountId === target.accountId);
  const chosen = allowed.find(plan => plan.id === cached?.planId);
  if (chosen || hasNewPublishingDraft(cached)) return chosen;
  return allowed.filter(plan => !plan.confirmedAt).sort((a, b) => b.createdAt - a.createdAt)[0];
}
