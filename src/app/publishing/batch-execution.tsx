/** 批次执行以简短汇总为主；长任务和诊断按需展开，归档等待真实完成。 */
"use client";
import { useState } from "react";
import type { PublishingPlan, VideoJob } from "@/shared/publishing";
import JobList from "./job-list";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import { publicationBucket } from "./publishing-overview";
import { executionCounts, executionMetrics } from "./batch-execution-data";
export type JobOperation = (id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) => Promise<void>;
/** 当前修订的持久公开/完成事实不因 API 观察字段过期消失。 */
function remoteComplete(job: VideoJob) { return ["published", "completed"].includes(publicationBucket(job)); }
/** 按真实报告统计，不把受理、上传结束或时间已到认作公开。 */
export default function BatchExecution({ plan, jobs, allJobs = jobs, busy, operate, archive }: { plan?: PublishingPlan; jobs: VideoJob[]; allJobs?: VideoJob[]; busy: boolean; operate: JobOperation; archive?(id: string): Promise<void> }) {
  const [page, setPage] = useState(0);
  const related = plan ? allJobs.filter(job => job.spec.profile.agentId === plan.profile.agentId && job.spec.contentPackage?.batchName.toLowerCase() === plan.batch.name.toLowerCase()) : [];
  const finished = !!plan && plan.batch.packages.length > 0 && plan.batch.packages.every(pkg => related.some(job => job.spec.contentPackage?.id === pkg.id && job.spec.contentPackage.version === pkg.version && remoteComplete(job)));
  const noActiveReference = related.every(job => remoteComplete(job) || job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision);
  const canArchive = !!plan?.confirmedAt && !plan.archivedAt && !plan.archivePending && finished && noActiveReference;
  const counts = executionCounts(jobs, plan); const metrics = executionMetrics(counts, (plan?.profile.privacy || jobs[0]?.spec.profile.privacy) === "public");
  const auxiliary = [counts.cancelled ? "已取消 " + counts.cancelled : "", counts.cancelPending ? "取消待确认 " + counts.cancelPending : ""].filter(Boolean);
  return <section aria-label="批次执行状态"><div className="publishing-section-heading"><h2>{plan?.batch.name || "发布任务"}</h2><span>{counts.total} 条</span></div>
    <dl className="publishing-execution-summary">{metrics.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
    {auxiliary.length > 0 && <p className="publishing-hint" role="status">{auxiliary.join(" · ")}</p>}
    {plan?.archivePending && <p className="publishing-message" role="status">归档待设备确认</p>}{plan?.archivedAt && <p className="publishing-message" role="status">已归档至 Completed</p>}
    {jobs.length > 0 && jobs.every(job => !job.observed || job.observed.revision !== job.spec.revision) && <p className="publishing-hint">已受理，等待设备确认。</p>}
    <details className="publishing-details publishing-execution-details"><summary>任务与操作</summary><JobList jobs={jobs.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE)} busy={busy} operate={operate} /><Pagination page={page} total={jobs.length} change={setPage} /></details>
    {archive && plan && <div className="publishing-actions"><button disabled={busy || !plan.archivePending && !canArchive} onClick={() => void archive(plan.id)}>{plan.archivePending ? "核对归档" : "归档批次"}</button>{!canArchive && !plan.archivedAt && !plan.archivePending && <span className="publishing-hint">全部内容发布完成后可归档。</span>}</div>}
  </section>;
}
