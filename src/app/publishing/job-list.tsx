/** 发布队列与历史：主行只显示进度和时间，恢复详情与操作影响按需展开。 */
"use client";
import { useState, type FormEvent, type SyntheticEvent } from "react";
import type { VideoJob } from "@/shared/publishing";
import { publishingTerminal } from "@/shared/publishing";
import { confirmedJobPublishAt, inputUtc, jobScheduleNotice, jobStatus, jobTimezone, localInputTime } from "./display";
import JobProgress from "./job-progress";

/** 用 Profile 时区显示已保存的 UTC 时刻，不依据浏览器时钟推断公开成功。 */
export function jobTime(job: VideoJob, actual = false, original = false) {
  const value = actual ? job.observed?.effectivePublishAt : original ? job.initialPublishAt || job.spec.originalPublishAt : job.spec.originalPublishAt;
  const timezone = jobTimezone(job);
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: timezone }) + " · " + timezone : "整理完成后";
}
/** 操作仅提交期望状态；尚未收到修订报告时保留“等待设备确认”。 */
export default function JobList({ jobs, busy, operate, cancelling = false, removed = false }: { jobs: VideoJob[]; busy: boolean; cancelling?: boolean; removed?: boolean; operate(id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string): Promise<boolean> }) {
  const [editing, setEditing] = useState(""); const [date, setDate] = useState(""); const [dateError, setDateError] = useState(""); const [expanded, setExpanded] = useState("");
  /** 一次展开一个视频的操作，所有视频的阶段仍默认可见；关掉旧详情不会清除新展开行。 */
  function toggleOperations(event: SyntheticEvent<HTMLDetailsElement>, id: string) { if (event.currentTarget.open) setExpanded(id); else setExpanded(current => current === id ? "" : current); }
  /** 编辑从当前计划预填墙上时间；重新打开可采用最新计划，失败提交保留本次输入。 */
  function editDate(job: VideoJob) {
    if (editing === job.spec.id + "-date") { setEditing(""); return; }
    setDate(job.spec.originalPublishAt ? localInputTime(job.spec.originalPublishAt, jobTimezone(job)) : ""); setDateError(""); setEditing(job.spec.id + "-date");
  }
  /** 本地时区校验不发送请求；服务器拒绝改期时保留表单，只有受理成功才关闭。 */
  async function submitDate(event: FormEvent<HTMLFormElement>, job: VideoJob) {
    event.preventDefault(); if (busy || cancelling || removed || job.spec.desired === "cancel" || publishingTerminal(job.observed?.state) || job.observed?.state === "needs_attention") return; setDateError("");
    let publishAt: string;
    try { publishAt = inputUtc(date, jobTimezone(job)); }
    catch (error) { setDateError(error instanceof Error && error.message === "这个时间不存在，请调整夏令时日期或时间。" ? error.message : "请选择有效的新发布时间。"); return; }
    if (await operate(job.spec.id, "reschedule", publishAt)) setEditing("");
    else setDateError("改期未提交，请查看上方提示后重试。");
  }
  if (!jobs.length) return <div className="publishing-empty"><h2>暂无任务</h2><p>确认批次后，任务会出现在这里。</p></div>;
  return <div className="publishing-job-list">{jobs.map(job => {
    const report = job.observed; const state = report?.state;
    const confirmedAt = confirmedJobPublishAt(job); const scheduleNotice = jobScheduleNotice(job);
    const percent = report ? Math.min(100, Math.floor(report.offset / report.total * 100)) : 0;
    const continued = job.spec.desired === "pause" || ["paused", "needs_attention", "retry_wait"].includes(state || "");
    const pendingCancel = job.spec.desired === "cancel" && report?.revision !== job.spec.revision;
    const controlsAvailable = !removed && (!publishingTerminal(state) || cancelling && state === "failed") && !pendingCancel;
    return <article key={job.spec.id} className="publishing-job">
      <div className="publishing-job-heading"><div className="publishing-file"><h2>{report?.metadata?.title || job.spec.contentPackage?.name || job.spec.asset.filename}</h2><span>{job.spec.contentPackage?.name && job.spec.contentPackage.name + " · "}{job.spec.profile.name} · {Math.round((report?.prepared?.size || job.spec.asset.size) / 1024 ** 2)} MiB{state === "uploading" && " · " + percent + "%"}</span></div><span className={"publishing-status state-" + state}>{jobStatus(job)}</span></div>
      {state === "uploading" && <progress aria-label={job.spec.asset.filename + " 上传进度"} max={report?.total} value={report?.offset} />}
      {job.spec.originalPublishAt && <p className="publishing-job-time">当前计划 · {jobTime(job)}{scheduleNotice && <span className="publishing-hint"> · {scheduleNotice}</span>}</p>}
      {confirmedAt && Date.parse(confirmedAt) !== Date.parse(job.spec.originalPublishAt || "") && <p className="publishing-hint">YouTube 已确认时间 · {jobTime(job, true)}</p>}
      <JobProgress job={job} />
      {job.blockReason && <p className="publishing-warning" role="status">{job.blockReason}</p>}
      {report?.message && <p className="publishing-message" role="status">{report.message}</p>}
      <details className="publishing-details publishing-job-operations" open={expanded === job.spec.id} onToggle={event => toggleOperations(event, job.spec.id)}><summary>操作与详情</summary>
      <div className="publishing-actions">
        {controlsAvailable && <>
          {!cancelling && <button disabled={busy} onClick={() => { if (continued) void operate(job.spec.id, "resume"); else if (state === "scheduled" || report?.effectivePublishAt) setEditing(job.spec.id + "-pause"); else void operate(job.spec.id, "pause"); }}>{continued ? "继续" : "暂停处理"}</button>}
          {!cancelling && job.spec.profile.scheduled && state !== "needs_attention" && job.spec.desired !== "cancel" && <button disabled={busy} onClick={() => editDate(job)}>改期</button>}
          <button className="btn-danger" disabled={busy} onClick={() => setEditing(editing === job.spec.id ? "" : job.spec.id)}>取消任务</button>
        </>}
        {!removed && (job.hadUpload || report?.videoId) && <button className="btn-ghost" disabled={busy} onClick={() => void operate(job.spec.id, "reconcile")}>核对状态</button>}
        {report?.videoId && <a href={"https://www.youtube.com/watch?v=" + report.videoId} target="_blank" rel="noreferrer">查看视频</a>}
      </div>
      <details className="publishing-details"><summary>任务详情</summary><dl className="publishing-summary">
        <div><dt>原计划</dt><dd>{jobTime(job, false, true)}</dd></div>
        {job.initialPublishAt && job.initialPublishAt !== job.spec.originalPublishAt && <div><dt>当前计划</dt><dd>{jobTime(job)}</dd></div>}
        {confirmedAt && <div><dt>YouTube 已确认时间</dt><dd>{jobTime(job, true)}</dd></div>}
        <div><dt>文件</dt><dd>{job.spec.asset.filename}</dd></div>
        <div><dt>频道</dt><dd>{job.spec.profile.channelId}</dd></div>
        <div><dt>已上传</dt><dd>{percent}%</dd></div>
      </dl></details>
      {controlsAvailable && !cancelling && editing === job.spec.id + "-pause" && <div className="publishing-warning"><p>暂停本地处理后，YouTube 已确认的排期仍会执行。要阻止公开，请取消任务并等待确认。</p><div className="publishing-actions"><button disabled={busy} onClick={async () => { if (await operate(job.spec.id, "pause")) setEditing(""); }}>确认暂停</button><button onClick={() => setEditing("")}>返回</button></div></div>}
      {controlsAvailable && editing === job.spec.id && <div className="publishing-warning"><p>取消任务并清除未公开的排期。设备离线时无法保证阻止公开；本地文件和视频保留。</p><div className="publishing-actions"><button className="btn-danger" disabled={busy} onClick={async () => { if (await operate(job.spec.id, "cancel")) setEditing(""); }}>确认取消</button><button onClick={() => setEditing("")}>保留任务</button></div></div>}
      {controlsAvailable && !cancelling && state !== "needs_attention" && job.spec.desired !== "cancel" && editing === job.spec.id + "-date" && <form className="publishing-reschedule" onSubmit={e => void submitDate(e, job)}><label>新发布时间 · {jobTimezone(job)}<input required disabled={busy} type="datetime-local" value={date} onChange={e => { setDate(e.target.value); setDateError(""); }} /></label>{dateError && <p className="publishing-validation" role="alert">{dateError}</p>}<div className="publishing-actions"><button className="btn-primary" disabled={busy} type="submit">提交改期</button><button type="button" disabled={busy} onClick={() => setEditing("")}>返回</button></div></form>}
      </details>
    </article>;
  })}</div>;
}
