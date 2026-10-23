/** 日志主行保持紧凑，关联元数据按需展开为整行，保留上下文与键盘可操作性。 */
"use client";
import { Fragment, useState } from "react";
import type { StoredYouTubeEvent } from "@/shared/youtube-usage";
import { blockReasonLabels, eventCostLabel, outcomeLabels, purposeLabels } from "./youtube-usage-model";
import YouTubeEventDetails from "./youtube-event-details";
import styles from "./youtube-usage.module.css";
/** 不加载其他服务；展开仅呈现 Cloud 已返回的白名单字段。 */
export default function YouTubeUsageEventRow({ event, device, time }: { event: StoredYouTubeEvent; device: string; time: (at: number) => string }) {
  const [expanded, setExpanded] = useState(false); const detailsId = "usage-" + event.eventId;
  return <Fragment><tr data-expanded={expanded}><td><time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time></td><td>{device}<br /><span className={styles.caption}>{event.instanceId}</span></td><td>{event.method}</td><td>{purposeLabels[event.purpose] || event.purpose}<br /><span className={styles.caption}>{event.trigger}</span></td><td>{event.kind === "start" ? "请求发出" : event.decision === "cache" ? "缓存命中" : event.decision === "blocked" ? "已拦截" : outcomeLabels[event.outcome || ""] || "调度记录"}{event.kind === "decision" && (event.count || 1) > 1 && <small className={styles.caption}>合并 {event.count?.toLocaleString("zh-CN")} 次</small>}{event.errorCode && <small className={styles.eventError}>{event.errorCode}</small>}</td><td>{event.blockReason ? blockReasonLabels[event.blockReason] || event.blockReason : "—"}{event.retryDelayMs !== undefined && <small className={styles.caption}>{time(event.at + event.retryDelayMs)}</small>}</td><td>{eventCostLabel(event)}</td><td>{event.durationMs === undefined ? "—" : event.durationMs.toLocaleString("zh-CN") + " ms"}</td><td><button type="button" className={styles.detailToggle} aria-expanded={expanded} aria-controls={detailsId} aria-label={event.method + " 的关联与连接信息"} onClick={() => setExpanded(value => !value)}>{expanded ? "收起详情" : "查看详情"}</button></td></tr>{expanded && <tr id={detailsId} className={styles.detailRow}><td colSpan={9}><YouTubeEventDetails event={event} /></td></tr>}</Fragment>;
}
