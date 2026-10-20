/** 日志探索的侧栏筛选与已选条件；只构造 Cloud 日志查询，不触发平台请求。 */
"use client";
import { useEffect, useRef } from "react";
import { youtubeMethodSchema, youtubePurposeSchema, type YouTubeUsageQuery } from "@/shared/youtube-usage";
import { outcomeLabels, purposeLabels } from "./youtube-usage-model";
import styles from "./youtube-usage.module.css";
type Props = { query: YouTubeUsageQuery; devices: { agentId: string; name: string }[]; change: (key: keyof YouTubeUsageQuery, value: string | number) => void; clear: () => void };
/** 桌面固定侧栏、手机折叠，按字段逐项撤销，不改变 PT 配额日。 */
export default function YouTubeUsageFilters({ query, devices, change, clear }: Props) {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width:700px)");
    /** 断点切换只调整筛选面板开合，保留已选条件与整个查询上下文。 */
    const adapt = () => { if (panel.current) panel.current.open = !media.matches; };
    adapt(); media.addEventListener("change", adapt); return () => media.removeEventListener("change", adapt);
  }, []);
  const selected: [keyof YouTubeUsageQuery, string][] = [["agentId", "设备"], ["instanceId", "实例"], ["method", "方法"], ["purpose", "来源"], ["outcome", "结果"], ["from", "起始时间"], ["to", "截止时间"]];
  return <details className={styles.filterPanel} ref={panel} open><summary>筛选调用记录</summary>
    {selected.some(([key]) => query[key] !== undefined) && <div className={styles.appliedFilters} aria-label="已应用筛选">{selected.filter(([key]) => query[key] !== undefined).map(([key, label]) => <button key={key} type="button" aria-label={"清除" + label + "筛选"} onClick={() => change(key, "")}>{label}：{key === "agentId" ? devices.find(d => d.agentId === query[key])?.name || query[key] : key === "purpose" ? purposeLabels[String(query[key])] : key === "outcome" ? outcomeLabels[String(query[key])] : key === "from" || key === "to" ? new Date(Number(query[key])).toISOString().slice(11,16) : String(query[key])}<span aria-hidden="true"> ×</span></button>)}<button type="button" className={styles.clearFilters} onClick={clear}>清空筛选</button></div>}
    <div className={styles.filters}>
      <label>设备<select aria-label="设备" value={query.agentId || ""} onChange={e => change("agentId", e.target.value)}><option value="">全部设备</option>{devices.map(d => <option key={d.agentId} value={d.agentId}>{d.name}</option>)}</select></label>
      <label>实例 ID<input value={query.instanceId || ""} placeholder="全部实例" onChange={e => change("instanceId", e.target.value)} /></label>
      <label>API 方法<select aria-label="API 方法" value={query.method || ""} onChange={e => change("method", e.target.value)}><option value="">全部方法</option>{youtubeMethodSchema.options.map(method => <option key={method}>{method}</option>)}</select></label>
      <label>来源<select aria-label="来源" value={query.purpose || ""} onChange={e => change("purpose", e.target.value)}><option value="">全部来源</option>{youtubePurposeSchema.options.map(p => <option key={p} value={p}>{purposeLabels[p]}</option>)}</select></label>
      <label>结果<select aria-label="结果" value={query.outcome || ""} onChange={e => change("outcome", e.target.value)}><option value="">全部结果</option>{Object.entries(outcomeLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>起始时间（UTC）<input type="datetime-local" value={query.from ? new Date(query.from).toISOString().slice(0,16) : ""} onChange={e => change("from", e.target.value ? Date.parse(e.target.value + "Z") : "")} /></label>
      <label>截止时间（UTC）<input type="datetime-local" value={query.to ? new Date(query.to).toISOString().slice(0,16) : ""} onChange={e => change("to", e.target.value ? Date.parse(e.target.value + "Z") : "")} /></label>
    </div>
  </details>;
}
