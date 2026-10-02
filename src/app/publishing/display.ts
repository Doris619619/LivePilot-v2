/** 发布页面共用简短名称与计数；显示文案不参与任务状态推断。 */
import type { PublishingProfile, VideoJob } from "@/shared/publishing";
import { publishingTerminal } from "@/shared/publishing";
import { Temporal } from "@js-temporal/polyfill";
import { publicationBudgetWaiting } from "./publishing-overview";
export { titleCharacters, descriptionBytes } from "@/shared/video-metadata";
/** 将用户选择的隐私与公开方式转为确认页可读名称。 */
export function visibilityLabel(profile: PublishingProfile) {
  return profile.privacy === "public" ? profile.scheduled ? "定时公开" : "处理后公开" : profile.privacy === "private" ? "私密" : "不公开";
}
const states: Record<string, string> = { draft: "草稿", ready: "待处理", preparing_media: "正在生成", generating_metadata: "生成文案", uploading: "上传中", processing: "YouTube 处理中", finalizing: "整理发布设置", scheduled: "已排期", published: "已公开", completed: "已完成", retry_wait: "等待恢复", needs_attention: "需要处理", paused: "本地已暂停", cancelled: "已取消", failed: "失败" };
/** 控制意图与真实终态优先；自动预算等候独立命名，避免误称需要人工处理或设备尚未接收。 */
export function jobStatus(job: VideoJob) {
  if (!job.observed || job.observed.revision !== job.spec.revision) return job.spec.desired === "pause" ? "暂停待设备确认" : job.spec.desired === "cancel" ? "取消待设备确认" : publicationBudgetWaiting(job) ? "等待预算" : "等待设备接收";
  if (!publishingTerminal(job.observed.state) && job.observed.state !== "needs_attention") {
    if (job.spec.desired === "pause" && job.observed.state !== "paused") return "暂停待设备确认";
    if (job.spec.desired === "cancel" && job.observed.state !== "cancelled") return "取消待设备确认";
    if (publicationBudgetWaiting(job) && job.observed.state !== "paused") return "等待预算";
  }
  return states[job.observed.state] || "待上传";
}
/** 原生时间输入使用计划时区的墙上时间，不依据浏览器时区改写 UTC。 */
export function localInputTime(instant: string, timezone: string) {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
/** 手工重复时刻采用第一次；不存在的夏令时时刻拒绝，避免静默移动。 */
export function inputUtc(local: string, timezone: string) {
  const wall = Temporal.PlainDateTime.from(local); const zoned = wall.toZonedDateTime(timezone, { disambiguation: "earlier" });
  if (!zoned.toPlainDateTime().equals(wall)) throw new Error("这个时间不存在，请调整夏令时日期或时间。");
  return zoned.toInstant().toString({ fractionalSecondDigits: 3 });
}
/** 页面只格式化真实保存的时刻，不据此推断任务已发布。 */
export function planTime(instant: string | undefined, timezone: string) {
  return instant ? new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant)) : "完成后";
}
