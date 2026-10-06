/** 发布月历：按所选显示时区排列固定 UTC 时间，移动端使用日期格与单日清单。 */
"use client";
import { useEffect, useState } from "react";
import type { VideoJob } from "@/shared/publishing";
import { jobStatus } from "./display";
import { jobCalendarPublishAt, jobTimezone } from "./publishing-time";

/** Intl 分段避免依赖浏览器的日期分隔符和本地月份顺序。 */
function localDate(value: string | number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
/** 月份加减只使用 UTC 日历字段，不受浏览器夏令时影响。 */
function moveMonth(month: string, delta: number) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + delta, 1)).toISOString().slice(0, 7);
}
/** 所有任务共用一个显示时区；确认后的 UTC 排期不会被显示选择修改。 */
export default function PublishingCalendar({ jobs }: { jobs: VideoJob[] }) {
  const zones = [...new Set(jobs.map(jobTimezone))];
  if (!zones.length) zones.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [choice, setChoice] = useState(zones[0]); const timezone = zones.includes(choice) ? choice : zones[0];
  const [now, setNow] = useState(() => Date.now()); const today = localDate(now, timezone);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const [month, setMonth] = useState(today.slice(0, 7)); const [selected, setSelected] = useState(today);
  const [year, index] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1)); const weekday = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const cells = Array.from({ length: Math.ceil((weekday + days) / 7) * 7 }, (_, offset) => new Date(Date.UTC(year, index - 1, offset - weekday + 1)).toISOString().slice(0, 10));
  const groups = new Map<string, VideoJob[]>();
  for (const job of jobs) {
    const instant = jobCalendarPublishAt(job); if (!instant) continue;
    const date = localDate(instant, timezone); const group = groups.get(date) || []; group.push(job); groups.set(date, group);
  }
  for (const group of groups.values()) group.sort((a, b) => Date.parse(jobCalendarPublishAt(a)!) - Date.parse(jobCalendarPublishAt(b)!));
  /** 跳月时将单日清单切到该月第一天。 */
  function navigate(delta: number) { const next = moveMonth(month, delta); setMonth(next); setSelected(next + "-01"); }
  return <section aria-label="发布月历">
    <div className="publishing-calendar-toolbar"><div className="publishing-month-navigation">
      <button aria-label="上个月" onClick={() => navigate(-1)}>‹</button><h2>{year} 年 {index} 月</h2><button aria-label="下个月" onClick={() => navigate(1)}>›</button>
      <button className="btn-ghost" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>今天</button>
    </div><label>显示时区<select value={timezone} onChange={e => setChoice(e.target.value)}>{zones.map(zone => <option key={zone}>{zone}</option>)}</select></label></div>
    <div className="publishing-month" role="group" aria-label={year + " 年 " + index + " 月"}>
      {["一", "二", "三", "四", "五", "六", "日"].map(day => <div className="publishing-weekday" key={day}>周{day}</div>)}
      {cells.map(date => { const items = groups.get(date) || []; return <button key={date} className={"publishing-calendar-day " + (date === selected ? "is-selected " : "") + (date.slice(0, 7) !== month ? "is-outside" : "")} aria-label={date + "，" + items.length + " 个视频"} aria-pressed={date === selected} onClick={() => setSelected(date)}>
        <time dateTime={date} className={date === today ? "is-today" : ""}>{Number(date.slice(8))}</time>
        <span className="publishing-calendar-count">{items.length ? items.length + " 个" : ""}</span>
        <span className="publishing-calendar-previews">{items.slice(0, 2).map(job => <span key={job.spec.id} className={"publishing-calendar-title " + (job.observed?.state === "published" ? "is-published" : "")}>{job.observed?.metadata?.title || job.spec.asset.filename}</span>)}{items.length > 2 && <span>+{items.length - 2}</span>}</span>
      </button>; })}
    </div>
    <div className="publishing-section-heading"><h2>{selected}</h2><span>{(groups.get(selected) || []).length} 个视频</span></div>
    <div className="publishing-agenda">{(groups.get(selected) || []).map(job => <article key={job.spec.id}><time>{new Date(jobCalendarPublishAt(job)!).toLocaleTimeString("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit" })}</time><h3>{job.observed?.metadata?.title || job.spec.asset.filename}</h3><span className={"publishing-status state-" + job.observed?.state}>{jobStatus(job)}</span></article>)}{!groups.has(selected) && <p className="publishing-hint">当天暂无排期</p>}</div>
  </section>;
}
