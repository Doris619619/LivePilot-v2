/** 配额日的设备、实例、方法及来源归因；清楚区分真实出站日志和准入预扣。 */
"use client";
import { useUrlState } from "../use-url-state";
import type { YouTubeUsageSummary } from "@/shared/youtube-usage";
import { purposeLabels } from "./youtube-usage-model";
import styles from "./youtube-usage.module.css";
const tabs = ["设备", "实例", "API 方法", "来源"] as const;
/** 以紧凑切换避免四份排行榜挤占日志主区；点击实体复用右侧日志筛选。 */
export default function YouTubeUsageRanking({ summary, deviceName, choose }: { summary: YouTubeUsageSummary; deviceName: (id: string) => string; choose: (key: "agentId" | "instanceId" | "method" | "purpose", value: string, agentId?: string) => void }) {
  const [tab, setTab] = useUrlState<typeof tabs[number]>("usage-ranking", "设备", raw => tabs.includes(raw as typeof tabs[number]) ? raw as typeof tabs[number] : "设备");
  const rows = tab === "设备" ? summary.ranking.map(r => ({ key: r.key, label: deviceName(r.key), units: r.units, field: "agentId" as const })) : tab === "实例" ? (summary.instanceRanking || []).map(r => ({ key: r.instanceId, agentId: r.agentId, label: deviceName(r.agentId) + " / " + r.instanceId, units: r.units, field: "instanceId" as const })) : Object.entries(tab === "API 方法" ? summary.byMethod : summary.byPurpose).map(([key, units]) => ({ key, label: purposeLabels[key] || key, units, field: tab === "API 方法" ? "method" as const : "purpose" as const }));
  return <section className={styles.breakdown} aria-label="全日消耗归因"><h2>全日消耗归因</h2><div className={styles.rankTabs}>{tabs.map(label => <button type="button" key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</div><p className={styles.caption}>{tab === "来源" ? "按来源预扣预算" : "按实际出站尝试统计"}</p>{tab === "实例" && summary.instanceRanking === undefined ? <p className={styles.empty}>当前服务尚未提供实例汇总</p> : !rows.length ? <p className={styles.empty}>尚无调用记录</p> : <ol className={styles.ranking}>{rows.sort((a,b) => b.units - a.units).slice(0,8).map((row,index) => <li key={row.key + index}><button type="button" onClick={() => choose(row.field, row.key, "agentId" in row ? row.agentId : undefined)}>{row.label}</button><strong>{row.units.toLocaleString("zh-CN")} <small>units</small></strong></li>)}</ol>}</section>;
}
