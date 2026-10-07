/** 批次删除的持久意图与安全完成判断；不删任务、素材或 YouTube 视频，不发起网络操作。 */
import { AppError } from "@/core/errors";
import type { PublishingBatchRemoval, PublishingProfile, VideoJob } from "@/shared/publishing";

export type BatchRemovalRecord = PublishingBatchRemoval & { owner: string; actor: string; target: Pick<PublishingProfile, "agentId" | "instanceId" | "accountId" | "channelId">; jobIds: string[]; expectedJobs: number };

/** 仅当前修订的取消、真实公开或非定时私密/不公开完成可安全结束；failed 和未知结果都不算。 */
export function safeRemovalJob(job: VideoJob) {
  const report = job.observed;
  if (!report || report.revision !== job.spec.revision || report.authorizationInvalid) return false;
  if (report.state === "published") return true;
  if (report.state === "cancelled") return report.observedPrivacy !== "public";
  return report.state === "completed" && (report.observedPrivacy === "public" || !job.spec.profile.scheduled && ["private", "unlisted"].includes(job.spec.profile.privacy));
}

/** 删除重复请求不废弃正在返回的取消确认；只为尚无取消意图的不安全任务创建新修订。 */
export function cancelRemovalJobs(jobs: VideoJob[], actor: string) {
  for (const job of jobs) {
    const retry = job.observed?.revision === job.spec.revision && ["failed", "needs_attention"].includes(job.observed.state);
    if (safeRemovalJob(job) || job.spec.desired === "cancel" && !retry) continue;
    job.spec.desired = "cancel"; job.spec.actor = actor; job.spec.revision++;
    delete job.spec.reconcileRevision; delete job.spec.reconcileTotal;
    delete job.blockReason; delete job.budgetWaiting;
  }
}

/** 按最初固定的任务集合确认；授权清理导致任务缺失也不能把空数组误认为删除完成。 */
export function finishBatchRemovals(records: BatchRemovalRecord[], jobs: VideoJob[], now = Date.now()) {
  for (const removal of records) {
    const expected = new Set(removal.jobIds);
    const current = jobs.filter(job => job.spec.batchId === removal.batchId);
    // 当前修订的新异常不得继续隐藏；已经完成后的隐私清理或旧观察不推翻原确认。
    if (removal.completedAt) {
      if (current.some(job => job.observed?.revision === job.spec.revision && !safeRemovalJob(job))) delete removal.completedAt;
      else continue;
    }
    if (expected.size !== removal.expectedJobs || removal.jobIds.length !== removal.expectedJobs) continue;
    if (current.length !== removal.expectedJobs || current.some(job => !expected.has(job.spec.id) || !safeRemovalJob(job))) continue;
    removal.completedAt = now;
  }
}

/** 返回浏览器最小标记，内部归属、目标和预期任务清单不进入 DTO。 */
export function removalView(record: BatchRemovalRecord): PublishingBatchRemoval {
  return { batchId: record.batchId, requestedAt: record.requestedAt, ...(record.completedAt ? { completedAt: record.completedAt } : {}), ...(record.name ? { name: record.name } : {}) };
}

/** 批次删除后禁止恢复上传或改期；等待时只允许继续取消和只读核对。 */
export function assertRemovalControl(records: BatchRemovalRecord[], batchId: string, operation?: "cancel" | "reconcile") {
  const removal = records.find(record => record.batchId === batchId);
  if (removal && (removal.completedAt || !operation)) throw new AppError("BATCH_REMOVAL", removal.completedAt ? "批次已移出总览，历史记录保留。" : "批次正在删除，请等待设备确认。", 409);
}
