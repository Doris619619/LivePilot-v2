/** 批次执行默认显示逐视频阶段并分页；操作和诊断按需展开，归档等待真实完成。 */
"use client";
import { useState } from "react";
import type { PublishingBatchRemoval, PublishingPlan, VideoJob } from "@/shared/publishing";
import BatchRemoval, { type BatchRemovalOperation } from "./batch-removal";
import JobList from "./job-list";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import { publicationBucket } from "./publishing-overview";
import { executionCounts, executionMetrics } from "./batch-execution-data";
import { publishingRemovalFeedback, type PublishingDevice } from "./publishing-removal-feedback";
/** 返回 Cloud 是否接受操作；true 不代表 Agent 或 YouTube 已经应用。 */
export type JobOperation = (id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) => Promise<boolean>;
/** 当前修订的持久公开/完成事实不因 API 观察字段过期消失。 */
function remoteComplete(job: VideoJob) { return ["published", "completed"].includes(publicationBucket(job)); }
/** 按真实报告统计，不把受理、上传结束或时间已到认作公开。 */
export default function BatchExecution({ plan, jobs, allJobs = jobs, busy, operate, archive, removal, devices, removeBatch }: { plan?: PublishingPlan; jobs: VideoJob[]; allJobs?: VideoJob[]; busy: boolean; operate: JobOperation; archive?(id: string): Promise<void>; removal?: PublishingBatchRemoval; devices?: PublishingDevice[]; removeBatch?: BatchRemovalOperation }) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(jobs.length / PACKAGE_PAGE_SIZE) - 1));
  const related = plan ? allJobs.filter(job => job.spec.profile.agentId === plan.profile.agentId && job.spec.contentPackage?.batchName.toLowerCase() === plan.batch.name.toLowerCase()) : [];
  const finished = !!plan && plan.batch.packages.length > 0 && plan.batch.packages.every(pkg => related.some(job => job.spec.contentPackage?.id === pkg.id && job.spec.contentPackage.version === pkg.version && remoteComplete(job)));
  const noActiveReference = related.every(job => remoteComplete(job) || job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision);
  const canArchive = !!plan?.confirmedAt && !plan.archivedAt && !plan.archivePending && finished && noActiveReference;
  const counts = executionCounts(jobs, plan); const metrics = executionMetrics(counts, (plan?.profile.privacy || jobs[0]?.spec.profile.privacy) === "public");
  const auxiliary = [counts.cancelled ? "已取消 " + counts.cancelled : "", counts.cancelPending ? "取消待确认 " + counts.cancelPending : ""].filter(Boolean);
  const batchId = plan?.id || jobs[0]?.spec.batchId; const batchName = plan?.batch.name || jobs[0]?.spec.profile.name || "发布任务";
  const feedback = publishingRemovalFeedback(removal, jobs, devices, plan?.profile.agentId);
  return <section aria-label="批次执行状态"><div className="publishing-section-heading"><h2>{batchName}</h2><div className="publishing-batch-controls"><span>{counts.total} 条</span>{removeBatch && batchId && <BatchRemoval batchId={batchId} name={batchName} removal={removal} busy={busy} remove={removeBatch} />}</div></div>
    {feedback && <p className={feedback.tone === "error" ? "publishing-validation" : "publishing-warning"} role="status">{feedback.message}</p>}
    <dl className="publishing-execution-summary">{metrics.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
    {auxiliary.length > 0 && <p className="publishing-hint" role="status">{auxiliary.join(" · ")}</p>}
    {plan?.archivePending && <p className="publishing-message" role="status">归档待设备确认</p>}{plan?.archivedAt && <p className="publishing-message" role="status">已归档至 Completed</p>}
    {!removal && jobs.length > 0 && jobs.every(job => !job.observed || job.observed.revision !== job.spec.revision) && <p className="publishing-hint">已受理，等待设备确认。</p>}
    <JobList jobs={jobs.slice(currentPage * PACKAGE_PAGE_SIZE, (currentPage + 1) * PACKAGE_PAGE_SIZE)} busy={busy} operate={operate} cancelling={!!removal} removed={!!removal?.completedAt} /><Pagination page={currentPage} total={jobs.length} change={setPage} />
    {archive && plan && !removal && <div className="publishing-actions"><button disabled={busy || !plan.archivePending && !canArchive} onClick={() => void archive(plan.id)}>{plan.archivePending ? "核对归档" : "归档批次"}</button>{!canArchive && !plan.archivedAt && !plan.archivePending && <span className="publishing-hint">全部内容发布完成后可归档。</span>}</div>}
  </section>;
}
