/** 单视频六阶段进度：只依据设备报告推进，上传百分百与时间已到均不能证明排期或公开。 */
import type { PublishingReport, VideoJob } from "@/shared/publishing";
import { confirmedJobPublishAt, jobStatus } from "./display";
import { publicationBucket } from "./publishing-overview";
import styles from "./job-progress.module.css";
type Tone = "active" | "waiting" | "paused" | "error";
export type JobProgressModel = { labels: string[]; stage: number; complete: boolean; tone: Tone; text: string };
/** 异常报告不含内部 resumeState；已上传、处理结果和候选排期只定位出错阶段，不证明其成功。 */
function evidenceStage(report: PublishingReport | undefined) {
  if (report?.videoId) {
    if (report.state === "failed" || ["failed", "terminated"].includes(report.processingStatus || "")) return 2;
    if (report.effectivePublishAt || report.processingStatus === "succeeded") return 3;
    return 2;
  }
  return report && (report.offset > 0 || report.metadata || report.prepared) ? 1 : 0;
}
/** 当前修订的远端终态才完成全部阶段；旧报告和候选 effectivePublishAt 只保留之前的文件进度。 */
export function jobProgress(job: VideoJob): JobProgressModel {
  const publicVideo = job.spec.profile.privacy === "public";
  const labels = ["准备文件", "上传 YouTube", "YouTube 处理", publicVideo ? job.spec.profile.scheduled ? "确认排期" : "确认公开" : "确认设置", publicVideo ? "等待公开" : "保存视频", publicVideo ? "已公开" : "已完成"];
  const report = job.observed; const current = report?.revision === job.spec.revision; const bucket = publicationBucket(job);
  if (bucket === "published" || bucket === "completed") return { labels, stage: 5, complete: true, tone: "active", text: publicVideo ? "YouTube 已公开" : "YouTube 已完成" };
  let stage = evidenceStage(report);
  if (["draft", "ready", "preparing_media", "generating_metadata"].includes(report?.state || "")) stage = 0;
  else if (report?.state === "uploading") stage = 1;
  else if (report?.state === "processing") stage = 2;
  else if (report?.state === "finalizing") stage = 3;
  else if (report?.state === "scheduled") stage = confirmedJobPublishAt(job) ? 4 : 3;
  else if (report && ["published", "completed"].includes(report.state)) stage = 3;
  if (!current) return { labels, stage, complete: false, tone: "waiting", text: jobStatus(job) };
  if (report && ["needs_attention", "failed"].includes(report.state)) return { labels, stage, complete: false, tone: "error", text: labels[stage] + " · 需要处理" };
  if (job.spec.desired === "pause" || report?.state === "paused") return { labels, stage, complete: false, tone: "paused", text: jobStatus(job) };
  if (job.spec.desired === "cancel" || report?.state === "cancelled") return { labels, stage, complete: false, tone: "paused", text: jobStatus(job) };
  if (report?.state === "retry_wait" || job.blockReason) return { labels, stage, complete: false, tone: "waiting", text: jobStatus(job) };
  const percent = report ? Math.min(100, Math.floor(report.offset / report.total * 100)) : 0;
  const text = report?.state === "uploading" ? "正在上传 · " + percent + "%" : stage === 4 ? "等待 YouTube 公开" : report?.state === "generating_metadata" ? "正在生成文案" : report?.state === "ready" ? "等待处理" : labels[stage] + "中";
  return { labels, stage, complete: false, tone: "active", text };
}
/** 默认展示六条细阶段及短当前说明；错误使用文字和符号，同时保留屏幕阅读器阶段状态。 */
export default function JobProgress({ job }: { job: VideoJob }) {
  const progress = jobProgress(job);
  return <div className={styles.progress}>
    <p className={styles.status + " " + styles[progress.tone]}>{progress.text}</p>
    <ol className={styles.steps} aria-label="发布进度">
      {progress.labels.map((label, index) => {
        const done = progress.complete || index < progress.stage; const active = !progress.complete && index === progress.stage;
        const state = done ? "done" : active ? progress.tone : "later";
        return <li key={label} className={styles[state]} aria-current={active ? "step" : undefined} aria-label={label + "，" + (done ? "已完成" : active ? progress.tone === "error" ? "需要处理" : progress.text : "尚未到达")}><span aria-hidden="true">{done ? "✓" : active && progress.tone === "error" ? "!" : index + 1}</span><span>{label}</span></li>;
      })}
    </ol>
  </div>;
}
