/** 发布时间的显示边界：用户当前计划、已确认排期及历史记录分别处理，候选时间不证明远端生效。 */
import { publishingTerminal, type VideoJob } from "@/shared/publishing";

/** 无效观察时间不能污染总览或使日历格式化失败。 */
function validInstant(value: string | undefined) { return value && Number.isFinite(Date.parse(value)) ? value : undefined; }

/** 单项改期与计划共用时区，浏览器位置不能改变同一任务的时间含义。 */
export function jobTimezone(job: VideoJob) { return job.spec.plan?.timezone || job.spec.profile.schedule.timezone; }

/** 只有运行意图下当前修订的私密排期回读才能称已确认；暂停和取消等待应用时不能继承此结论。 */
export function confirmedJobPublishAt(job: VideoJob) {
  const report = job.observed;
  return job.spec.desired === "run" && job.spec.profile.privacy === "public" && job.spec.profile.scheduled && report?.revision === job.spec.revision && report.state === "scheduled" && report.videoId && report.observedPrivacy === "private" && report.remoteCheckedAt ? validInstant(report.effectivePublishAt) : undefined;
}

/** 活动任务优先已确认的远端排期，否则显示用户当前计划；旧修订和本次上传候选不能覆盖改期。 */
export function jobDisplayPublishAt(job: VideoJob) { return confirmedJobPublishAt(job) || validInstant(job.spec.originalPublishAt); }

/** 日历保留当前终态任务的排期记录；记录不代表精确公开时刻，活动任务仍遵守当前计划与确认边界。 */
export function jobCalendarPublishAt(job: VideoJob) {
  return job.observed?.revision === job.spec.revision && publishingTerminal(job.observed.state) ? validInstant(job.observed.effectivePublishAt) || validInstant(job.spec.originalPublishAt) : jobDisplayPublishAt(job);
}
