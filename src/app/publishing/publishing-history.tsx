/** 紧凑发布历史：对齐内容与结果，一次只展开一项，核对操作不影响列表读取。 */
"use client";
import { Fragment, useState } from "react";
import type { PublishingPlan, VideoJob } from "@/shared/publishing";
import type { JobOperation } from "./batch-execution";
import type { OverviewTarget } from "./publishing-overview";
import { jobStatus } from "./display";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import { filterHistory, historyResultLabels, historyTime, publishingHistory, type HistoryResult, type HistoryRow } from "./publishing-history-data";
import styles from "./publishing-history.module.css";

type Props = { plans: PublishingPlan[]; jobs: VideoJob[]; targets: OverviewTarget[]; busy: boolean; operate: JobOperation };

/** 历史详情保留原任务的核对和视频入口；排期时间、最近记录与真实公开结果分别标注。 */
function HistoryDetail({ row, busy, operate }: { row: HistoryRow; busy: boolean; operate: JobOperation }) {
  const { job, timezone } = row; const report = job.observed!;
  const pending = report.revision !== job.spec.revision;
  return <section className={styles.detail} id={"history-detail-" + job.spec.id} aria-label={row.title + " 历史详情"}>
    {(job.blockReason || report.message) && <p className={styles.message}>{job.blockReason || report.message}</p>}
    {pending && <p className={styles.message}>{jobStatus(job)}；以上结果为最近一次已确认记录。</p>}
    <dl className={styles.facts}>
      <div><dt>原计划</dt><dd>{historyTime(job.initialPublishAt || job.spec.originalPublishAt, timezone)}</dd></div>
      {report.effectivePublishAt && <div><dt>YouTube 确认排期</dt><dd>{historyTime(report.effectivePublishAt, timezone)}</dd></div>}
      <div><dt>时区</dt><dd>{timezone}</dd></div>
      <div><dt>最近记录</dt><dd>{historyTime(report.updatedAt, timezone)}</dd></div>
      <div><dt>文件</dt><dd>{job.spec.asset.filename}</dd></div>
      <div><dt>大小</dt><dd>{Math.round((report.prepared?.size || job.prepared?.size || job.spec.asset.size) / 1024 ** 2)} MiB</dd></div>
    </dl>
    {report.metadata?.description && <details className={styles.description}><summary>视频说明</summary><p>{report.metadata.description}</p></details>}
    <div className={styles.actions}><button disabled={busy} onClick={() => void operate(job.spec.id, "reconcile")}>核对状态</button>{report.videoId && <a href={"https://www.youtube.com/watch?v=" + report.videoId} target="_blank" rel="noreferrer">查看视频</a>}</div>
  </section>;
}

/** 搜索和筛选不请求 YouTube；始终先筛选全部缓存数据，再限制每页25条。 */
export default function PublishingHistory({ plans, jobs, targets, busy, operate }: Props) {
  const [query, setQuery] = useState(""); const [result, setResult] = useState<HistoryResult | "">(""); const [page, setPage] = useState(0); const [expanded, setExpanded] = useState("");
  const rows = publishingHistory(plans, jobs, targets); const filtered = filterHistory(rows, query, result);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PACKAGE_PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PACKAGE_PAGE_SIZE, (currentPage + 1) * PACKAGE_PAGE_SIZE);
  /** 筛选变化回到第一页并收起详情，避免看见已被筛掉的记录。 */
  function search(value: string) { setQuery(value); setPage(0); setExpanded(""); }
  /** 结果筛选不修改持久任务状态。 */
  function chooseResult(value: HistoryResult | "") { setResult(value); setPage(0); setExpanded(""); }
  /** 分页只移动当前视图；一次仅允许一个展开项。 */
  function changePage(value: number) { setPage(value); setExpanded(""); }
  return <section aria-label="发布历史" className={styles.history}>
    <div className={styles.toolbar}>
      <label className={styles.search}><span className="sr-only">搜索发布历史</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" aria-label="搜索发布历史" placeholder="搜索内容或发布包" value={query} onChange={event => search(event.target.value)} /></label>
      <label className={styles.resultFilter}><span className="sr-only">发布结果</span><select aria-label="发布结果" value={result} onChange={event => chooseResult(event.target.value as HistoryResult | "")}><option value="">全部结果</option>{Object.entries(historyResultLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span className={styles.count} role="status">{filtered.length} 条记录</span>
    </div>
    {visible.length ? <table className={styles.table} aria-label="发布历史记录"><colgroup><col className={styles.contentColumn} /><col className={styles.batchColumn} /><col className={styles.channelColumn} /><col className={styles.timeColumn} /><col className={styles.resultColumn} /><col className={styles.actionColumn} /></colgroup>
      <thead><tr><th scope="col">内容</th><th scope="col">发布包</th><th scope="col">频道</th><th scope="col">计划时间</th><th scope="col">结果</th><th scope="col"><span className="sr-only">详情</span></th></tr></thead>
      <tbody>{visible.map(row => { const id = row.job.spec.id; const open = id === expanded; return <Fragment key={id}>
        <tr className={styles.row + (open ? " " + styles.expanded : "")}>
          <th scope="row" className={styles.content}><span title={row.title}>{row.title}</span><span className={styles.mobileContext} aria-hidden="true">{row.batch} · {row.channel}</span></th>
          <td className={styles.batch}><span title={row.batch}>{row.batch}</span></td>
          <td className={styles.channel}><span title={row.channel}>{row.channel}</span></td>
          <td className={styles.time}>{row.plannedAt ? <time dateTime={row.plannedAt} title={row.timezone}>{historyTime(row.plannedAt, row.timezone)}</time> : "—"}</td>
          <td className={styles.result}><span className={styles.badge + " " + styles[row.result]}>{row.resultLabel}</span></td>
          <td className={styles.toggle}><button className="btn-ghost" aria-expanded={open} aria-controls={"history-detail-" + id} aria-label={(open ? "收起" : "查看") + row.title + "详情"} onClick={() => setExpanded(open ? "" : id)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 9 6 6 6-6" /></svg></button></td>
        </tr>
        {open && <tr className={styles.detailRow}><td colSpan={6}><HistoryDetail row={row} busy={busy} operate={operate} /></td></tr>}
      </Fragment>; })}</tbody>
    </table> : <div className={styles.empty}><h2>{rows.length ? "没有匹配的记录" : "暂无发布历史"}</h2>{rows.length > 0 && <button className="btn-ghost" onClick={() => { search(""); chooseResult(""); }}>清除筛选</button>}</div>}
    <Pagination page={currentPage} total={filtered.length} change={changePage} />
  </section>;
}
