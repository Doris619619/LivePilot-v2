/** 管理员 YouTube 数据台：只读取 Cloud 已记录事件，隐藏或离开页签即停止刷新。 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type YouTubeEventsPage, type YouTubeUsageQuery, type YouTubeUsageSummary } from "@/shared/youtube-usage";
import { api } from "../client-request";
import { useWorkbenchActive } from "../components/workbench-context";
import YouTubePolicyEditor from "./youtube-policy";
import YouTubeUsageTrend from "./youtube-usage-trend";
import YouTubeUsageEventRow from "./youtube-usage-event-row";
import YouTubeUsageFilters from "./youtube-usage-filters";
import YouTubeUsageRanking from "./youtube-usage-ranking";
import { exhaustionLabel, pacificToday, usageQuery } from "./youtube-usage-model";
import styles from "./youtube-usage.module.css";
const number = new Intl.NumberFormat("zh-CN");
/** 将 Unix 时间按管理员已选择的时区显示，保留原始 UTC 到 time 标签。 */
function time(at: number | undefined, zone: string) { return at ? new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at) : "尚未同步"; }
/** 已有状态数据使用原位更新；读取失败保留上一份且显式标记过期。 */
export default function YouTubeUsage({ active, timeZone }: { active: boolean; timeZone: string }) {
  const workbench = useWorkbenchActive(); const [query, setQuery] = useState<YouTubeUsageQuery>({ day: pacificToday() });
  const [summary, setSummary] = useState<YouTubeUsageSummary>(); const [page, setPage] = useState<YouTubeEventsPage>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"usage" | "settings">("usage");
  const mounted = useRef(false); const inFlight = useRef<AbortController | undefined>(undefined); const [refresh, setRefresh] = useState(0);
  const enabled = active && workbench; const queryString = usageQuery(query);
  /** 调度以显示状态为准；并发读取共用一次，请求卸载后不再修改页面。 */
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try { const [nextSummary, nextPage] = await Promise.all([api<YouTubeUsageSummary>("/api/admin/youtube-usage?" + usageQuery({ day: query.day }), { signal }), api<YouTubeEventsPage>("/api/admin/youtube-usage/events?" + queryString, { signal })]); if (!signal.aborted && mounted.current) { setSummary(nextSummary); setPage(nextPage); setError(""); } }
    catch (failure) { if (!signal.aborted && mounted.current) setError((failure as Error).message); }
    finally { if (!signal.aborted && mounted.current) setLoading(false); }
  }, [query.day, queryString]);
  useEffect(() => {
    mounted.current = true;
    /** 隐藏时立即取消读取，恢复可见再从已落盘计量刷新，不触发上游。 */
    function tick() { if (!enabled || document.visibilityState === "hidden" || inFlight.current) return; const controller = new AbortController(); inFlight.current = controller; void load(controller.signal).finally(() => { if (inFlight.current === controller) inFlight.current = undefined; }); }
    /** 浏览器可见性变化与页签切换共用相同的请求取消规则。 */
    function visibility() { if (document.visibilityState === "hidden") { inFlight.current?.abort(); inFlight.current = undefined; } else tick(); }
    const initial = setTimeout(tick, 0); const timer = setInterval(tick, 15_000); document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); inFlight.current?.abort(); inFlight.current = undefined; };
  }, [enabled, load, refresh]);
  /** 新筛选重置游标，防止跨设备或日期复用上一页的结果。 */
  function filter(key: keyof YouTubeUsageQuery, value: string | number) { setQuery(current => ({ ...current, [key]: value || undefined, cursor: undefined })); }
  /** 清除日志范围但保留配额日，避免一键清除意外切换预算口径。 */
  function clearFilters() { setQuery(current => ({ day: current.day })); }
  const devices = summary?.coverage.devices || []; const deviceName = (id: string) => devices.find(device => device.agentId === id)?.name || id;
  const warning = !!summary && summary.baseline.units + summary.usedUnits + summary.reservedUnits >= summary.policy.dailyUnits * 0.8;
  return <section className={styles.root} aria-label="YouTube 配额数据台" aria-busy={loading}>
    <nav className={styles.subtabs} aria-label="数据台视图"><button type="button" aria-pressed={view === "usage"} onClick={() => setView("usage")}>用量与日志</button><button type="button" aria-pressed={view === "settings"} onClick={() => setView("settings")}>保护设置</button></nav>
    <div className={styles.toolbar}><label>配额日（太平洋时间）<input aria-label="配额日" type="date" value={query.day || ""} onChange={event => filter("day", event.target.value)} /></label><button onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新记录</button><span>太平洋时间午夜重置 · {summary ? "最近同步 " + time(summary.lastSyncedAt, timeZone) : "正在读取记录"}</span></div>
    {error && <p className={styles.error} role="alert">{error} · 当前展示上次读取的记录。</p>}
    {!summary ? !error && <p role="status">正在读取 YouTube 用量…</p> : <>
      {!summary.baseline.known && <p className={styles.warning} role="alert">当前日此前用量未知，新的 YouTube 请求已暂停。请在“当日基线”填写控制台读数或保守估计。</p>}
      {summary.breakerUntil && <p className={styles.warning} role="alert">项目已暂停非必要调用，等待 {time(summary.breakerUntil, timeZone)} 后恢复。OBS 推流与本机停止仍独立运行。</p>}
      {summary.storage?.blocked && <p className={styles.warning} role="alert">配额账本容量已达到上限，新的 Google 请求已暂停；已有 OBS 推流继续。本机停止仍可用，请联系管理员处理账本容量。</p>}
      <dl className={styles.budget} data-warning={warning}><div><dt>本应用预计通用 units</dt><dd>{number.format(summary.usedUnits)} <small>/ {number.format(summary.policy.dailyUnits)}</small></dd></div><div><dt>可用预算</dt><dd>{number.format(summary.remainingUnits)}</dd></div><div><dt>任务已预留 units</dt><dd>{number.format(summary.reservedUnits)}</dd></div><div><dt>控制专用预留 units</dt><dd>{number.format(summary.policy.controlReserve)}</dd></div><div><dt>项目熔断状态</dt><dd>{summary.breakerUntil ? "已触发" : "未触发"}</dd></div><div><dt>按近期速率预计耗尽</dt><dd>{exhaustionLabel(summary)}</dd></div></dl>
      {warning && <p className={styles.warning} role="status">已用及预留达到预算的 80%。请查看下方设备与调用来源；已预留操作继续安全收尾。</p>}
      <p className={styles.caption}>这些是本应用按官方成本估算的用量，包含保守计入的未知结果；Google 实际已用配额与其他应用消耗请查看控制台。成本版本 {summary.costVersion}。</p>
      <p className={styles.caption}>接入前基线 {summary.baseline.known ? number.format(summary.baseline.units) + " units" : "未知"} · 已上传 {summary.uploads} / {summary.policy.uploadsPerDay} 次 · 搜索 {summary.searches === undefined ? "—" : summary.searches} / {summary.policy.searchesPerDay} 次{summary.resetAt ? " · 下次重置 " + time(summary.resetAt, timeZone) : ""}</p>
      {summary.storage && <p className={styles.caption}>配额账本占用 {(summary.storage.bytes / 1024 ** 2).toFixed(1)} / {(summary.storage.limit / 1024 ** 2).toFixed(1)} MiB{summary.storage.blocked ? " · 已达上限" : ""}</p>}
      <div className={styles.coverage}><strong>保护覆盖 {summary.coverage.protected} / {summary.coverage.total} 台</strong><span>调用 {number.format(summary.totals.attempts)} · 失败 {number.format(summary.totals.failures)} · 缓存命中 {number.format(summary.totals.cacheHits)} · 已拦截 {number.format(summary.totals.blocked)}</span>{devices.some(device => !device.protected) && <p className={styles.warning}>以下设备尚未接入保护，不能保证项目总量完整：{devices.filter(device => !device.protected).map(device => device.name).join("、")}。请升级并保持在线。</p>}{(summary.incomplete || summary.droppedEvents > 0) && <p className={styles.warning}>部分明细缺失，丢弃事件 {summary.droppedEvents} 条；当前记录不能作为完整调用账单。</p>}</div>
      <div hidden={view !== "usage"}><YouTubeUsageTrend summary={summary} timeZone={timeZone} from={query.from} to={query.to} choose={(from,to) => setQuery(current => ({ ...current, from, to, cursor: undefined }))} /></div>
      <div hidden={view !== "settings"}><YouTubePolicyEditor key={summary.day + summary.project} summary={summary} updated={next => { setSummary(next); setRefresh(value => value + 1); }} /></div>
    </>}
    <section className={styles.events} hidden={view !== "usage"}><div className={styles.eventsHeading}><h2>调用记录</h2><div><a href={"/api/admin/youtube-usage/export?" + usageQuery({ ...query, cursor: undefined }) + "&format=csv"} download>导出 CSV</a><a href={"/api/admin/youtube-usage/export?" + usageQuery({ ...query, cursor: undefined }) + "&format=ndjson"} download>导出 JSONL</a></div></div>
      <div className={styles.investigation}><aside><YouTubeUsageFilters query={query} devices={devices} change={filter} clear={clearFilters} />{summary && <YouTubeUsageRanking summary={summary} deviceName={deviceName} choose={(key,value,agentId) => setQuery(current => ({ ...current, [key]: value, ...(agentId ? { agentId } : {}), cursor: undefined }))} />}</aside><div className={styles.results}>
      <div className={styles.tableWrap}><table className="admin-table"><thead><tr><th>时间</th><th>设备 / 实例</th><th>API 方法</th><th>来源 / 触发</th><th>结果</th><th>等待原因 / 下次检查</th><th>预计 units</th><th>耗时</th><th>关联与连接</th></tr></thead><tbody>{page?.events.map(event => <YouTubeUsageEventRow key={event.eventId} event={event} device={deviceName(event.agentId)} time={at => time(at, timeZone)} />)}</tbody></table></div>
      {page?.expired && <p className={styles.warning} role="status">所选范围包含已过14天保留期的明细，无法作为完整记录；明细保留下界 {time(page.detailsAvailableFrom, timeZone)}，90天日汇总仍可查询。</p>}{page && page.droppedEvents > 0 && <p className={styles.warning} role="alert">已记录的明细存在异常缺口，缺失事件 {page.droppedEvents} 条。</p>}{page && !page.events.length && <p className={styles.empty}>{page.expired ? "保留期内无匹配明细，较早明细已过期。" : page.incomplete ? "明细存在缺口，当前没有匹配记录。" : "此筛选条件下暂无记录"}</p>}{page?.nextCursor && <button disabled={loading} onClick={() => setQuery(current => ({ ...current, cursor: page.nextCursor }))}>下一页</button>}{query.cursor && <button disabled={loading} onClick={() => setQuery(current => ({ ...current, cursor: undefined }))}>返回最新记录</button>}
      </div></div>
    </section>
  </section>;
}
