/** 我的发布以带稳定频道标识的分区汇总批次，公开进度来自真实报告，日历与历史共享原任务。 */
"use client";
import { useEffect, useState } from "react";
import { type PublishingBatchRemoval, type PublishingPlan, type VideoJob } from "@/shared/publishing";
import BatchRemoval, { type BatchRemovalOperation } from "./batch-removal";
import BatchExecution, { type JobOperation } from "./batch-execution";
import PublishingCalendar from "./publishing-calendar";
import PublishingHistory from "./publishing-history";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import { planTime } from "./display";
import { publishingOverview, type OverviewTarget, type PublishingOverviewBatch } from "./publishing-overview";
import type { PublishingDevice } from "./publishing-removal-feedback";
import styles from "./my-publishing.module.css";

type Props = { initialView?: "总览" | "历史"; plans: PublishingPlan[]; jobs: VideoJob[]; allJobs?: VideoJob[]; targets?: OverviewTarget[]; removals?: PublishingBatchRemoval[]; devices?: PublishingDevice[]; busy: boolean; operate: JobOperation; archive(id: string): Promise<void>; removeBatch?: BatchRemovalOperation };

/** 由不可变频道 ID 选择标识色；更名、筛选、分页不会变色，身份仍以名称和分区边界表示。 */
function channelAccent(channelId: string) {
  const accents = ["blue", "violet", "teal", "indigo", "slate"];
  let hash = 2166136261;
  for (const character of channelId) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return accents[(hash >>> 0) % accents.length];
}

/** 一行批次展示真实完成量，主动再次发布标记独立一轮，详情及恢复操作按需展开。 */
function OverviewBatch({ batch, now, open, busy, removeBatch }: { batch: PublishingOverviewBatch; now: number; open(): void; busy: boolean; removeBatch?: BatchRemovalOperation }) {
  const { counts, next } = batch; const done = counts.published + counts.completed;
  const label = batch.plan?.profile.privacy === "public" || batch.jobs.some(job => job.spec.profile.privacy === "public") ? "已公开" : "已完成";
  return <article className={styles.batch} aria-label={"批次 " + batch.name}>
    <div className={styles.batchHeading}><h3>{batch.name}{!!batch.plan?.republishJobIds?.length && " · 再次发布"}</h3><span className={styles.status + " " + styles[batch.tone]}>{batch.state}</span></div>
    <div className={styles.progressArea}>
      <div className={styles.counts}><strong>{label} {done}</strong><span>待发布 {counts.pending}</span>{counts.attention > 0 && <span className={styles.error}>需处理 {counts.attention}</span>}{counts.cancelled > 0 && <span>已取消 {counts.cancelled}</span>}</div>
      <progress aria-label={batch.name + " 发布完成进度"} value={done} max={Math.max(1, counts.total)} />
      {counts.excluded > 0 && <span className={styles.excluded}>暂不发布 {counts.excluded}</span>}
    </div>
    <div className={styles.batchAction}>{next && !batch.removal && <span>{Date.parse(next.instant) <= now ? "待核对" : "下一条"} <time dateTime={next.instant}>{planTime(next.instant, next.timezone)}</time></span>}<div className={styles.batchButtons}><button className="btn-ghost" onClick={open}>查看详情</button>{removeBatch && <BatchRemoval batchId={batch.plan?.id || batch.jobs[0].spec.batchId} name={batch.name} removal={batch.removal} busy={busy} remove={removeBatch} />}</div></div>
    {batch.removalFeedback && <p className={styles.removalFeedback + " " + (batch.removalFeedback.tone === "error" ? styles.error : "")} role="status">{batch.removalFeedback.message}</p>}
  </article>;
}

/** 默认跨所有权限内设备按频道汇总；筛选不修改任务归属，返回保留频道与分页位置。 */
export default function MyPublishing({ initialView = "总览", plans, jobs, allJobs, targets = [], removals = [], devices, busy, operate, archive, removeBatch }: Props) {
  const [tab, setTab] = useState<string>(initialView); const [selected, setSelected] = useState(""); const [channel, setChannel] = useState(""); const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** 只更新“等待公开确认”的时间提示，不根据浏览器时钟推进任务状态。 */
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const channels = publishingOverview(plans, jobs, targets, now, removals, devices);
  const channelOptions = publishingOverview(plans, jobs, targets, now);
  const choice = channelOptions.some(value => value.id === channel) ? channel : "";
  const visible = channels.filter(value => !choice || value.id === choice);
  const batch = visible.flatMap(value => value.batches).find(value => value.key === selected);
  const scopedJobs = choice ? jobs.filter(job => job.spec.profile.channelId === choice) : jobs;
  const batches = visible.flatMap(value => value.batches);
  const orphaned = removals.filter(value => !value.completedAt && !plans.some(plan => plan.id === value.batchId) && !jobs.some(job => job.spec.batchId === value.batchId));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(batches.length / PACKAGE_PAGE_SIZE) - 1));
  const pageKeys = new Set(batches.slice(currentPage * PACKAGE_PAGE_SIZE, (currentPage + 1) * PACKAGE_PAGE_SIZE).map(value => value.key));
  return <section aria-label="我的发布总览">
    {orphaned.map(value => <p className="publishing-warning" role="status" key={value.batchId}>{value.name || "批次"}：删除未确认，任务记录不可用。请到 YouTube Studio 检查未公开排期。</p>)}
    <div className={styles.toolbar}><nav className="publishing-subnav" aria-label="我的发布视图">{["总览", "日历", "历史"].map(name => <button key={name} className={tab === name ? "is-active" : "btn-ghost"} aria-pressed={tab === name} onClick={() => { setTab(name); setPage(0); }}>{name}</button>)}</nav>
      {channelOptions.length > 1 && <label className={styles.channelFilter}><span className="sr-only">发布频道</span><select aria-label="发布频道" value={choice} onChange={event => { setChannel(event.target.value); setSelected(""); setPage(0); }}><option value="">全部频道</option>{channelOptions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
    </div>
    {tab === "日历" ? <PublishingCalendar jobs={scopedJobs} /> : tab === "历史" ? <PublishingHistory key={choice} plans={plans} jobs={scopedJobs} targets={targets} removals={removals} busy={busy} operate={operate} />
      : batch ? <><button className="btn-ghost" onClick={() => setSelected("")}>返回总览</button><BatchExecution key={batch.key} plan={batch.plan} jobs={batch.jobs} allJobs={allJobs} busy={busy} operate={operate} archive={batch.plan ? archive : undefined} removal={batch.removal} devices={devices} removeBatch={removeBatch} /></>
        : <>{visible.map(value => { const pageBatches = value.batches.filter(item => pageKeys.has(item.key)); if (!pageBatches.length) return null; const accent = channelAccent(value.id); return <section className={styles.channel + " " + styles[accent]} key={value.id} data-channel-id={value.id} data-channel-accent={accent} aria-label={"频道 " + value.name}>
          <header className={styles.channelHeading}><div className={styles.channelIdentity}><span className={styles.channelAvatar} aria-hidden="true">{Array.from(value.name.trim())[0]?.toLocaleUpperCase() || "Y"}</span><div className={styles.channelTitle}><h2>{value.name}</h2>{value.device && <p>{value.device}</p>}</div></div><span className={styles.packageCount}>{value.batches.length} 个发布包</span></header>
          {pageBatches.map(item => <OverviewBatch key={item.key} batch={item} now={now} busy={busy} removeBatch={removeBatch} open={() => setSelected(item.key)} />)}
        </section>; })}<Pagination page={currentPage} total={batches.length} change={setPage} />
          {!batches.length && <div className="publishing-empty"><h2>还没有配置好的发布包</h2></div>}
        </>}
  </section>;
}
