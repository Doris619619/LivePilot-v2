/** 发布页面共用简短名称与计数；显示文案不参与任务状态推断。 */
import type { PublishingProfile, VideoJob } from "@/shared/publishing";
import { publishingTerminal } from "@/shared/publishing";
export { titleCharacters, descriptionBytes } from "@/shared/video-metadata";
/** 将用户选择的隐私与公开方式转为确认页可读名称。 */
export function visibilityLabel(profile: PublishingProfile) {
  return profile.privacy === "public" ? profile.scheduled ? "定时公开" : "处理后公开" : profile.privacy === "private" ? "私密" : "不公开";
}
const states: Record<string, string> = { draft: "草稿", ready: "待上传", generating_metadata: "生成文案", uploading: "上传中", processing: "YouTube 处理中", finalizing: "整理发布设置", scheduled: "已定时", published: "已公开", completed: "已完成", retry_wait: "等待恢复", needs_attention: "需要处理", paused: "已暂停", cancelled: "已取消", failed: "失败" };
/** 修订未获 Agent 确认时显示待处理，避免将 Cloud 投递当作操作成功。 */
export function jobStatus(job: VideoJob) {
  if (!job.observed || job.observed.revision !== job.spec.revision) return job.spec.desired === "pause" ? "暂停待设备确认" : job.spec.desired === "cancel" ? "取消待设备确认" : "等待设备接收";
  if (!publishingTerminal(job.observed.state) && job.observed.state !== "needs_attention") {
    if (job.spec.desired === "pause" && job.observed.state !== "paused") return "暂停待设备确认";
    if (job.spec.desired === "cancel" && job.observed.state !== "cancelled") return "取消待设备确认";
  }
  return states[job.observed.state] || "待上传";
}
