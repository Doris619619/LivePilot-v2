/** 分钟图以固定时间轴呈现 Cloud 已记录值，点击或键盘操作可定位该分钟的调用记录。 */
"use client";
import { useUrlState } from "../use-url-state";
import type { YouTubeUsageSummary } from "@/shared/youtube-usage";
import styles from "./youtube-usage.module.css";
const number = new Intl.NumberFormat("zh-CN");
/** 以最近已记录分钟为终点补齐一小时轴，空记录不绘制虚构图表。 */
export default function YouTubeUsageTrend({ summary, timeZone, choose, from, to }: { summary: YouTubeUsageSummary; timeZone: string; from?: number; to?: number; choose: (from: number, to: number) => void }) {
  const [hour, setHour] = useUrlState<number | undefined>("usage-hour", undefined, raw => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined, value => value === undefined ? "" : String(value));
  if (!summary.minutes.length) return <section><h2>分钟用量</h2><p className={styles.empty}>尚无调用记录</p></section>;
  const hours = new Map<number, number>(); for (const point of summary.minutes) { const key = Math.floor(point.minute / 3600_000) * 3600_000; hours.set(key, (hours.get(key) || 0) + point.units); }
  const end = hour !== undefined && hours.has(hour) ? hour + 59 * 60_000 : Math.floor(Math.max(...summary.minutes.map(item => item.minute)) / 60_000) * 60_000;
  const points = Array.from({ length: 60 }, (_, index) => { const minute = end - (59 - index) * 60_000; return summary.minutes.find(item => item.minute === minute) || { minute, attempts: 0, units: 0 }; });
  const max = Math.max(1, ...points.map(item => item.units));
  const time = (at: number) => new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  return <section className={styles.chart}><div className={styles.chartHeading}><h2>项目分钟用量</h2><label>图表时段<select name="usageHour" autoComplete="off" aria-label="图表时段" value={hour !== undefined && hours.has(hour) ? hour : "latest"} onChange={event => setHour(event.target.value === "latest" ? undefined : Number(event.target.value))}><option value="latest">最近有记录的一小时</option>{[...hours].sort((a,b) => b[0] - a[0]).map(([at,units]) => <option key={at} value={at}>{new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", hour12: false }).format(at)} · {number.format(units)} units</option>)}</select></label></div><div className={styles.plot}><div className={styles.yAxis}><span>{number.format(max)}</span><span>{number.format(Math.round(max / 2))}</span><span>0</span></div><div className={styles.trend} aria-label="按分钟筛选调用记录">{points.map(item => <button key={item.minute} type="button" disabled={!item.attempts && !item.units} aria-pressed={from === item.minute && to === item.minute + 59_999} title={`${time(item.minute)} · ${number.format(item.units)} units · ${number.format(item.attempts)} 次`} aria-label={`${time(item.minute)}，预计 ${number.format(item.units)} units，${number.format(item.attempts)} 次调用，查看记录`} onClick={() => choose(item.minute, item.minute + 59_999)}><span style={{ height: item.units ? `${Math.max(2, item.units / max * 100)}%` : "0" }} /></button>)}</div></div><p className={styles.trendAxis}><span>{time(points[0].minute)}</span><span>{time(points[29].minute)}</span><span>{time(end)}</span></p><p className={styles.caption}>单位：预计 units / 分钟 · 点击柱形筛选下方日志；项目趋势不随日志筛选改变。</p></section>;
}
