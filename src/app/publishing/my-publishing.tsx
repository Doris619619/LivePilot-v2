/** 我的发布以频道和已确认批次为导览，公开进度来自真实报告，日历与历史共享原任务。 */
"use client";
import { useEffect, useState } from "react";
import { publishingTerminal, type PublishingPlan, type VideoJob } from "@/shared/publishing";
import BatchExecution, { type JobOperation } from "./batch-execution";
import PublishingCalendar from "./publishing-calendar";
import JobList from "./job-list";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import { planTime } from "./display";
import { publishingOverview, type OverviewTarget, type PublishingOverviewBatch } from "./publishing-overview";
import styles from "./my-publishing.module.css";

type Props = { plans: PublishingPlan[]; jobs: VideoJob[]; allJobs?: VideoJob[]; targets?: OverviewTarget[]; busy: boolean; operate: JobOperation; archive(id: string): Promise<void> };

/** 一行批次展示真实完成量与剩余状态，详细任务及恢复操作在查看后再展开。 */
function OverviewBatch({ batch, now, open }: { batch: PublishingOverviewBatch; now: number; open(): void }) {
  const { counts, next } = batch; const done = counts.published + counts.completed;
  const label = batch.plan?.profile.privacy === "public" || batch.jobs.some(job => job.spec.profile.privacy === "public") ? "已公开" : "已完成";
  return <article className={styles.batch} aria-label={"批次 " + batch.name}>
    <div className={styles.batchHeading}><h3>{batch.name}</h3><span className={styles.status + " " + styles[batch.tone]}>{batch.state}</span></div>
    <div className={styles.progressArea}>
      <div className={styles.counts}><strong>{label} {done}</strong><span>待发布 {counts.pending}</span>{counts.attention > 0 && <span className={styles.error}>需处理 {counts.attention}</span>}{counts.cancelled > 0 && <span>已取消 {counts.cancelled}</span>}</div>
      <progress aria-label={batch.name + " 发布完成进度"} value={done} max={Math.max(1, counts.total)} />
      {counts.excluded > 0 && <span className={styles.excluded}>暂不发布 {counts.excluded}</span>}
    </div>
    <div className={styles.batchAction}>{next && <span>{Date.parse(next.instant) <= now ? "待核对" : "下一条"} <time dateTime={next.instant}>{planTime(next.instant, next.timezone)}</time></span>}<button className="btn-ghost" onClick={open}>查看详情</button></div>
  </article>;
}

/** 默认跨所有权限内设备按频道汇总；筛选不修改任务归属，返回保留频道与分页位置。 */
export default function MyPublishing({ plans, jobs, allJobs, targets = [], busy, operate, archive }: Props) {
  const [tab, setTab] = useState("总览"); const [selected, setSelected] = useState(""); const [channel, setChannel] = useState(""); const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** 只更新“等待公开确认”的时间提示，不根据浏览器时钟推进任务状态。 */
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const channels = publishingOverview(plans, jobs, targets, now);
  const choice = channels.some(value => value.id === channel) ? channel : "";
  const visible = channels.filter(value => !choice || value.id === choice);
  const batch = visible.flatMap(value => value.batches).find(value => value.key === selected);
  const scopedJobs = choice ? jobs.filter(job => job.spec.profile.channelId === choice) : jobs;
  const history = scopedJobs.filter(job => publishingTerminal(job.observed?.state));
  const batches = visible.flatMap(value => value.batches); const pageKeys = new Set(batches.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE).map(value => value.key));
  return <section aria-label="我的发布总览">
    <div className={styles.toolbar}><nav className="publishing-subnav" aria-label="我的发布视图">{["总览", "日历", "历史"].map(name => <button key={name} className={tab === name ? "is-active" : "btn-ghost"} aria-pressed={tab === name} onClick={() => { setTab(name); setPage(0); }}>{name}</button>)}</nav>
      {channels.length > 1 && <label className={styles.channelFilter}><span className="sr-only">发布频道</span><select aria-label="发布频道" value={choice} onChange={event => { setChannel(event.target.value); setSelected(""); setPage(0); }}><option value="">全部频道</option>{channels.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
    </div>
    {tab === "日历" ? <PublishingCalendar jobs={scopedJobs} /> : tab === "历史" ? <><JobList jobs={history.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE)} busy={busy} operate={operate} /><Pagination page={page} total={history.length} change={setPage} /></>
      : batch ? <><button className="btn-ghost" onClick={() => setSelected("")}>返回总览</button><BatchExecution key={batch.key} plan={batch.plan} jobs={batch.jobs} allJobs={allJobs} busy={busy} operate={operate} archive={batch.plan ? archive : undefined} /></>
        : <>{visible.map(value => { const pageBatches = value.batches.filter(item => pageKeys.has(item.key)); if (!pageBatches.length) return null; return <section className={styles.channel} key={value.id} aria-label={"频道 " + value.name}>
          <header className={styles.channelHeading}><div><h2>{value.name}</h2>{value.device && <p>{value.device}</p>}</div><span>{value.batches.length} 个发布包</span></header>
          {pageBatches.map(item => <OverviewBatch key={item.key} batch={item} now={now} open={() => setSelected(item.key)} />)}
        </section>; })}<Pagination page={page} total={batches.length} change={setPage} />
          {!batches.length && <div className="publishing-empty"><h2>还没有配置好的发布包</h2></div>}
        </>}
  </section>;
}
