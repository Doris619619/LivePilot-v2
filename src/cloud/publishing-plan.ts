/** 发布包计划的纯预览计算：手动固定、自动避让和逐字段文案；不执行网络或存储操作。 */
import { AppError } from "@/core/errors";
import { expandTemplate } from "@/core/publishing/metadata";
import { schedulePlanSlots, occupiedPublishingSlots } from "@/core/publishing/schedule";
import { planItemSchema, type JobSpec, type PublishingPlan, type PublishingPlanItem, type VideoJob } from "@/shared/publishing";
export { occupiedPublishingSlots };
/** 手动时间固定；自动项重新填空并避开已知任务与手动时间，排除项不占位。 */
export function generatePublishingPlan(plan: PublishingPlan, input: PublishingPlanItem[], jobs: VideoJob[]) {
  const items = input.map(item => planItemSchema.parse(item));
  if (items.length !== plan.batch.packages.length || new Set(items.map(item => item.packageId)).size !== items.length || items.some(item => !plan.batch.packages.some(pkg => pkg.id === item.packageId))) throw new AppError("INPUT", "计划须保留批次全部发布包，每个包只出现一次。");
  const used = occupiedPublishingSlots(jobs, plan.profile.channelId);
  for (const item of items.filter(item => !item.excluded && item.scheduleSource === "manual")) {
    if (!plan.profile.scheduled) continue;
    if (!item.publishAt || Date.parse(item.publishAt) <= Date.now()) throw new AppError("INPUT", "手动发布时刻必须在未来。");
    const at = Date.parse(item.publishAt); if (used.has(at)) throw new AppError("CONFLICT", "手动发布时刻已被该频道占用，请调整。", 409); used.add(at);
  }
  const automatic = items.filter(item => !item.excluded && item.scheduleSource === "auto");
  const schedule = plan.profile.scheduled ? schedulePlanSlots(plan.rule, automatic.length, used) : { slots: [], skipped: [], skippedOccupied: 0 };
  let next = 0;
  plan.items = items.map(item => { if (item.excluded) return { ...item, publishAt: undefined }; if (!plan.profile.scheduled) return { ...item, publishAt: undefined }; return item.scheduleSource === "manual" ? item : { ...item, publishAt: schedule.slots[next++].publishAt }; });
  plan.skipped = schedule.skipped; plan.skippedOccupied = schedule.skippedOccupied;
  plan.copies = plan.items.map((item, index) => {
    const pkg = plan.batch.packages.find(pkg => pkg.id === item.packageId)!;
    const context = { asset: pkg.sourceVideo || { filename: pkg.name + ".mp4" }, contentPackage: pkg, index: index + 1, profile: plan.profile, plan: plan.rule, originalPublishAt: item.publishAt } as JobSpec;
    return { packageId: item.packageId, title: item.title ?? pkg.title ?? expandTemplate(plan.profile.ai.enabled ? plan.profile.ai.fallbackTitle : plan.profile.titleTemplate, context), description: item.description ?? pkg.description ?? expandTemplate(plan.profile.ai.enabled ? plan.profile.ai.fallbackDescription : plan.profile.descriptionTemplate, context) };
  });
  return plan;
}
