/** 发布队列与历史：主行只显示进度和时间，恢复详情与操作影响按需展开。 */
"use client";
import { useState } from "react";
import type { VideoJob } from "@/shared/publishing";
import { publishingTerminal } from "@/shared/publishing";
import { jobStatus } from "./display";

/** 用 Profile 时区显示已保存的 UTC 时刻，不依据浏览器时钟推断公开成功。 */
export function jobTime(job: VideoJob, actual = false, original = false) {
  const value = actual ? job.observed?.effectivePublishAt : original ? job.initialPublishAt || job.spec.originalPublishAt : job.spec.originalPublishAt;
  const timezone = job.spec.plan?.timezone || job.spec.profile.schedule.timezone;
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: timezone }) + " · " + timezone : "整理完成后";
}
/** 操作仅提交期望状态；尚未收到修订报告时保留“等待设备确认”。 */
export default function JobList({ jobs, busy, operate }: { jobs: VideoJob[]; busy: boolean; operate(id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string): Promise<void> }) {
  const [editing, setEditing] = useState(""); const [date, setDate] = useState("");
  if (!jobs.length) return <div className="publishing-empty"><h2>暂无任务</h2><p>确认批次后，任务会出现在这里。</p></div>;
  return <div className="publishing-job-list">{jobs.map(job => {
    const report = job.observed; const state = report?.state;
    const percent = report ? Math.min(100, Math.floor(report.offset / report.total * 100)) : 0;
    const continued = job.spec.desired === "pause" || ["paused", "needs_attention", "retry_wait"].includes(state || "");
    const pendingCancel = job.spec.desired === "cancel" && report?.revision !== job.spec.revision;
    return <article key={job.spec.id} className="publishing-job">
      <div className="publishing-job-heading"><div className="publishing-file"><h2>{report?.metadata?.title || job.spec.contentPackage?.name || job.spec.asset.filename}</h2><span>{job.spec.profile.name} · {Math.round((report?.prepared?.size || job.spec.asset.size) / 1024 ** 2)} MiB{state === "uploading" && " · " + percent + "%"}</span></div><span className={"publishing-status state-" + state}>{jobStatus(job)}</span></div>
      {state === "uploading" && <progress aria-label={job.spec.asset.filename + " 上传进度"} max={report?.total} value={report?.offset} />}
      {job.spec.originalPublishAt && <p className="publishing-job-time">{jobTime(job, !!report?.effectivePublishAt)}</p>}
      {job.blockReason && <p className="publishing-warning" role="status">{job.blockReason}</p>}
      {report?.message && <p className="publishing-message" role="status">{report.message}</p>}
      <div className="publishing-actions">
        {!publishingTerminal(state) && !pendingCancel && <>
          <button disabled={busy} onClick={() => { if (continued) void operate(job.spec.id, "resume"); else if (state === "scheduled" || report?.effectivePublishAt) setEditing(job.spec.id + "-pause"); else void operate(job.spec.id, "pause"); }}>{continued ? "继续" : "暂停"}</button>
          {job.spec.profile.scheduled && <button disabled={busy} onClick={() => { setDate(""); setEditing(editing === job.spec.id + "-date" ? "" : job.spec.id + "-date"); }}>改期</button>}
          <button className="btn-danger" disabled={busy} onClick={() => setEditing(editing === job.spec.id ? "" : job.spec.id)}>取消任务</button>
        </>}
        <button className="btn-ghost" disabled={busy} onClick={() => void operate(job.spec.id, "reconcile")}>核对状态</button>
        {report?.videoId && <a href={"https://www.youtube.com/watch?v=" + report.videoId} target="_blank" rel="noreferrer">查看视频</a>}
      </div>
      <details className="publishing-details"><summary>任务详情</summary><dl className="publishing-summary">
        <div><dt>原计划</dt><dd>{jobTime(job, false, true)}</dd></div>
        {job.initialPublishAt && job.initialPublishAt !== job.spec.originalPublishAt && <div><dt>修订计划</dt><dd>{jobTime(job)}</dd></div>}
        {report?.effectivePublishAt && <div><dt>YouTube 生效时间</dt><dd>{jobTime(job, true)}</dd></div>}
        <div><dt>文件</dt><dd>{job.spec.asset.filename}</dd></div>
        <div><dt>频道</dt><dd>{job.spec.profile.channelId}</dd></div>
        <div><dt>已上传</dt><dd>{percent}%</dd></div>
      </dl></details>
      {editing === job.spec.id + "-pause" && <div className="publishing-warning"><p>暂停本地处理后，YouTube 已确认的排期仍会执行。要阻止公开，请取消任务并等待确认。</p><div className="publishing-actions"><button disabled={busy} onClick={() => { void operate(job.spec.id, "pause"); setEditing(""); }}>确认暂停</button><button onClick={() => setEditing("")}>返回</button></div></div>}
      {editing === job.spec.id && <div className="publishing-warning"><p>取消任务并清除未公开的排期。设备离线时无法保证阻止公开；本地文件和视频保留。</p><div className="publishing-actions"><button className="btn-danger" disabled={busy} onClick={() => { void operate(job.spec.id, "cancel"); setEditing(""); }}>确认取消</button><button onClick={() => setEditing("")}>保留任务</button></div></div>}
      {editing === job.spec.id + "-date" && <form className="publishing-reschedule" onSubmit={e => { e.preventDefault(); void operate(job.spec.id, "reschedule", new Date(date).toISOString()); setEditing(""); }}><label>新发布时间 · {Intl.DateTimeFormat().resolvedOptions().timeZone}<input required type="datetime-local" value={date} onChange={e => setDate(e.target.value)} /></label><div className="publishing-actions"><button className="btn-primary" disabled={busy} type="submit">提交改期</button><button type="button" onClick={() => setEditing("")}>返回</button></div></form>}
    </article>;
  })}</div>;
}
