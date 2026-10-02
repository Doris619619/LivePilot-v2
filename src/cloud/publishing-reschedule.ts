/** 已确认计划的排期预览和原任务修订；不更换素材、文案、授权或上传检查点。 */
import { AppError } from "@/core/errors";
import { occupiedPublishingSlots, schedulePlanSlots } from "@/core/publishing/schedule";
import { planItemSchema, type PublishingPlan, type PublishingPlanItem, type VideoJob } from "@/shared/publishing";

export type SchedulePreview = { id: string; planId: string; revision: number; actor: string; createdAt: number; appliedRevision?: number; plan: PublishingPlan; jobs: { id: string; fingerprint: string }[] };

/** 完成、取消中和需人工核对的任务保持原排期；暂停任务可改期但不得自动继续。 */
export function scheduleEditable(job: VideoJob) { return job.spec.profile.scheduled && job.spec.desired !== "cancel" && !["published", "completed", "cancelled", "failed", "needs_attention"].includes(job.observed?.state || ""); }

/** 只锁影响排期安全的状态；普通上传进度变化不会让用户刚看到的预览失效。 */
export function scheduleFingerprint(job: VideoJob) { return JSON.stringify({ revision: job.spec.revision, desired: job.spec.desired, editable: scheduleEditable(job), publishAt: job.spec.originalPublishAt, effective: job.observed?.effectivePublishAt, pending: job.pendingPublishAt }); }

/** 每个活动任务的意图、远端和待确认时刻均归原 Job；收到新修订确认前不让同批其他 Job 抢占。 */
function scheduleOwners(jobs: VideoJob[]) { const owners = new Map<number, Set<string>>(); for (const job of jobs) for (const at of occupiedPublishingSlots([job], job.spec.profile.channelId)) { const ids = owners.get(at) || new Set<string>(); ids.add(job.spec.id); owners.set(at, ids); } return owners; }

/** 同一时刻归属多个任务时也不能作为自身空位使用，必须先核对其他任务的占位。 */
function ownedByOther(owners: Map<number, Set<string>>, at: number, id: string) { return [...(owners.get(at) || [])].some(owner => owner !== id); }

/** 已确认包列表和文案不可从改期入口更改；只重新计算可编辑的自动项，手动项保持固定。 */
export function generateConfirmedSchedule(plan: PublishingPlan, input: PublishingPlanItem[] | undefined, jobs: VideoJob[]) {
  if (!plan.confirmedAt || !plan.profile.scheduled) throw new AppError("PLAN", "只有已配置的定时公开计划可重新设置时间。", 409);
  const current = jobs.filter(job => job.spec.batchId === plan.id);
  const byPackage = new Map(current.map(job => [job.spec.contentPackage?.id, job]));
  const incoming = (input || plan.items).map(item => planItemSchema.parse(item));
  if (incoming.length !== plan.items.length || new Set(incoming.map(item => item.packageId)).size !== incoming.length || incoming.some(item => !plan.items.some(old => old.packageId === item.packageId))) throw new AppError("INPUT", "改期须保留原计划全部发布包。");
  const moving: VideoJob[] = []; const locked: string[] = [];
  plan.items = plan.items.map(old => {
    const item = incoming.find(item => item.packageId === old.packageId)!;
    if (item.excluded !== old.excluded || item.title !== old.title || item.description !== old.description) throw new AppError("INPUT", "已配置计划只可更改时间，文案和发布包保持不变。");
    const job = byPackage.get(old.packageId);
    if (old.excluded || !job || !scheduleEditable(job)) { locked.push(old.packageId); const completed = job?.observed?.revision === job?.spec.revision && ["published", "completed"].includes(job?.observed?.state || ""); return job ? { ...old, scheduleSource: job.spec.scheduleSource || old.scheduleSource, publishAt: completed ? job.observed?.effectivePublishAt || job.initialPublishAt || job.spec.originalPublishAt : job.spec.originalPublishAt } : { ...old }; }
    moving.push(job); return { ...old, scheduleSource: item.scheduleSource, publishAt: item.publishAt };
  });
  const movingIds = new Set(moving.map(job => job.spec.id));
  const used = occupiedPublishingSlots(jobs.filter(job => !movingIds.has(job.spec.id)), plan.profile.channelId);
  const owners = scheduleOwners(moving);
  for (const item of plan.items.filter(item => !locked.includes(item.packageId) && item.scheduleSource === "manual")) {
    if (!item.publishAt || Date.parse(item.publishAt) <= Date.now()) throw new AppError("INPUT", "手动发布时刻必须在未来。");
    const at = Date.parse(item.publishAt); const id = byPackage.get(item.packageId)!.spec.id; if (used.has(at) || ownedByOther(owners, at, id)) throw new AppError("CONFLICT", "手动发布时刻已被该频道占用，请等待原任务确认改期或选择其他时间。", 409); used.add(at);
  }
  const automatic = plan.items.filter(item => !locked.includes(item.packageId) && item.scheduleSource === "auto");
  const reserved = new Set([...used, ...owners.keys()]);
  const generated = schedulePlanSlots(plan.rule, automatic.length, reserved, Date.now(), (at, index) => !used.has(at) && owners.get(at)?.has(byPackage.get(automatic[index].packageId)!.spec.id) === true && !ownedByOther(owners, at, byPackage.get(automatic[index].packageId)!.spec.id)); let next = 0;
  plan.items = plan.items.map(item => locked.includes(item.packageId) || item.scheduleSource === "manual" ? item : { ...item, publishAt: generated.slots[next++].publishAt });
  plan.skipped = generated.skipped; plan.skippedOccupied = generated.skippedOccupied; plan.scheduleLockedPackageIds = locked;
  return plan;
}

/** 确认前再次检查所见任务版本和频道占位；新进度、旧视频与末块未知检查点均保留。 */
export function applyConfirmedSchedule(plan: PublishingPlan, preview: SchedulePreview, jobs: VideoJob[], actor: string) {
  const current = jobs.filter(job => job.spec.batchId === plan.id);
  if (plan.revision !== preview.revision || current.length !== preview.jobs.length || current.some(job => preview.jobs.find(saved => saved.id === job.spec.id)?.fingerprint !== scheduleFingerprint(job))) throw new AppError("REVISION", "任务排期或执行状态已变化，请重新生成预览。", 409);
  const mutable = current.filter(scheduleEditable); const mutableIds = new Set(mutable.map(job => job.spec.id));
  const occupied = occupiedPublishingSlots(jobs.filter(job => !mutableIds.has(job.spec.id)), plan.profile.channelId);
  const owners = scheduleOwners(mutable);
  for (const job of mutable) {
    const item = preview.plan.items.find(item => item.packageId === job.spec.contentPackage?.id)!;
    if (!item?.publishAt || Date.parse(item.publishAt) <= Date.now()) throw new AppError("CONFLICT", "预览中的时间已过去，请重新生成预览。", 409);
    const at = Date.parse(item.publishAt); if (occupied.has(at) || ownedByOther(owners, at, job.spec.id)) throw new AppError("CONFLICT", "该频道时刻仍被其他任务占用，请刷新预览。", 409); occupied.add(at);
  }
  for (const job of mutable) {
    const item = preview.plan.items.find(item => item.packageId === job.spec.contentPackage?.id)!;
    if (job.spec.originalPublishAt === item.publishAt && job.spec.scheduleSource === item.scheduleSource && JSON.stringify(job.spec.plan) === JSON.stringify(preview.plan.rule)) continue;
    if (job.spec.originalPublishAt !== item.publishAt) job.pendingPublishAt ??= job.observed?.effectivePublishAt || job.spec.originalPublishAt;
    job.spec.originalPublishAt = item.publishAt; job.spec.scheduleSource = item.scheduleSource; job.spec.plan = structuredClone(preview.plan.rule); job.spec.actor = actor; job.spec.revision++;
  }
  plan.rule = structuredClone(preview.plan.rule); plan.items = structuredClone(preview.plan.items); plan.skipped = [...preview.plan.skipped]; plan.skippedOccupied = preview.plan.skippedOccupied; plan.revision++;
  return plan;
}
