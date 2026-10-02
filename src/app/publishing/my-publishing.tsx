/** 我的发布按批次汇总，日历和历史共享持久任务；旧版视频任务仍可操作。 */
"use client";
import { useState } from "react";
import { publishingTerminal, type PublishingPlan, type VideoJob } from "@/shared/publishing";
import BatchExecution, { type JobOperation } from "./batch-execution";
import PublishingCalendar from "./publishing-calendar";
import JobList from "./job-list";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
/** 批次清单只显示名称和完成量，内部恢复信息留在任务详情。 */
export default function MyPublishing({ plans, jobs, allJobs, busy, operate, archive }: { plans: PublishingPlan[]; jobs: VideoJob[]; allJobs?: VideoJob[]; busy: boolean; operate: JobOperation; archive(id: string): Promise<void> }) {
  const [tab, setTab] = useState("批次"); const [selected, setSelected] = useState(""); const [page, setPage] = useState(0);
  const confirmed = [...plans].filter(plan => plan.confirmedAt).sort((a, b) => b.createdAt - a.createdAt);
  const plan = confirmed.find(value => value.id === selected); const history = jobs.filter(job => publishingTerminal(job.observed?.state));
  return <section><nav className="publishing-subnav" aria-label="我的发布视图">{["批次", "日历", "历史"].map(name => <button key={name} className={tab === name ? "is-active" : "btn-ghost"} aria-pressed={tab === name} onClick={() => { setTab(name); setPage(0); }}>{name}</button>)}</nav>
    {tab === "日历" ? <PublishingCalendar jobs={jobs} /> : tab === "历史" ? <><JobList jobs={history.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE)} busy={busy} operate={operate} /><Pagination page={page} total={history.length} change={setPage} /></>
      : plan ? <><button className="btn-ghost" onClick={() => setSelected("")}>返回批次</button><BatchExecution key={plan.id} plan={plan} jobs={jobs.filter(job => job.spec.batchId === plan.id)} allJobs={allJobs} busy={busy} operate={operate} archive={archive} /></>
        : <><div className="publishing-my-batches">{confirmed.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE).map(value => {
          const batchJobs = jobs.filter(job => job.spec.batchId === value.id); const finished = batchJobs.filter(job => ["published", "completed"].includes(job.observed?.state || "")).length;
          return <article className="publishing-profile-row" key={value.id}><div><h2>{value.batch.name}</h2><p>{finished} / {batchJobs.length} 已完成{value.archivedAt && " · 已归档"}{value.archivePending && " · 归档待确认"}</p></div><button onClick={() => setSelected(value.id)}>查看</button></article>;
        })}</div><Pagination page={page} total={confirmed.length} change={setPage} />
          {jobs.some(job => !plans.some(value => value.id === job.spec.batchId)) && <details className="publishing-details"><summary>已有视频任务</summary><BatchExecution jobs={jobs.filter(job => !plans.some(value => value.id === job.spec.batchId))} busy={busy} operate={operate} /></details>}
          {!confirmed.length && !jobs.length && <div className="publishing-empty"><h2>还没有发布计划</h2></div>}
        </>}
  </section>;
}
