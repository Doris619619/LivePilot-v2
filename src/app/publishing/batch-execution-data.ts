/** 执行概览的互斥汇总：区分公开、排期和处理，旧修订只显示等待确认。 */
import type { PublishingPlan, VideoJob } from "@/shared/publishing";
import { publicationBucket } from "./publishing-overview";

export type ExecutionCounts = { total: number; pending: number; processing: number; scheduled: number; published: number; completed: number; attention: number; cancelled: number; cancelPending: number };

/** 复用真实完成边界；取消或暂停意图待确认、缺失任务及旧报告都不能冒充当前排期成功。 */
export function executionCounts(jobs: VideoJob[], plan?: PublishingPlan): ExecutionCounts {
  const counts: ExecutionCounts = { total: jobs.length, pending: 0, processing: 0, scheduled: 0, published: 0, completed: 0, attention: 0, cancelled: 0, cancelPending: 0 };
  for (const job of jobs) {
    const bucket = publicationBucket(job);
    if (bucket !== "pending") { counts[bucket]++; continue; }
    const current = job.observed?.revision === job.spec.revision;
    if (job.spec.desired === "cancel") { counts.cancelPending++; counts.pending++; }
    else if (job.spec.desired !== "run" || !current) counts.pending++;
    else if (job.observed?.state === "scheduled") counts.scheduled++;
    else if (["preparing_media", "generating_metadata", "uploading", "processing", "finalizing"].includes(job.observed?.state || "")) counts.processing++;
    else counts.pending++;
  }
  const missing = Math.max(0, (plan?.items.filter(item => !item.excluded).length || 0) - jobs.length);
  counts.total += missing; counts.pending += missing;
  return counts;
}

/** 公开任务最多五项指标；私密/不公开合并真实完成，取消放辅助行而非未完成库存。 */
export function executionMetrics(counts: ExecutionCounts, publicVideo: boolean): [string, number][] {
  const metrics: [string, number][] = [["待处理", counts.pending], ["处理中", counts.processing]];
  if (publicVideo) metrics.push(["已排期", counts.scheduled], ["已公开", counts.published]);
  else metrics.push(["已完成", counts.completed + counts.published]);
  metrics.push(["异常", counts.attention]);
  return metrics;
}
