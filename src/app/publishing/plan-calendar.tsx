/** 草稿计划的月历与日期清单，共用已经保存的排期；视图切换不修改任务时间。 */
"use client";
import { useId, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { PublishingPlan, PublishingPlanItem } from "@/shared/publishing";
import { localInputTime } from "./display";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import "./plan-calendar.css";

type Entry = { item: PublishingPlanItem; name: string; title: string; day: string; time: string };
type Props = { plan: PublishingPlan; editingId?: string; busy: boolean; edit(item: PublishingPlanItem): void };
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

/** 固定 UTC 排期按计划时区归日，不能按浏览器本地日期分组。 */
function entriesFor(plan: PublishingPlan): Entry[] {
  const packages = new Map(plan.batch.packages.map(pkg => [pkg.id, pkg]));
  const copies = new Map(plan.copies.map(copy => [copy.packageId, copy]));
  return plan.items.map(item => {
    const name = packages.get(item.packageId)?.name || "视频";
    const local = item.publishAt ? localInputTime(item.publishAt, plan.rule.timezone) : "";
    return { item, name, title: item.title ?? copies.get(item.packageId)?.title ?? name, day: local.slice(0, 10), time: local.slice(11, 16) };
  });
}

/** 月份运算和周一开头的日期格使用纯日历，不受设备时区或夏令时影响。 */
function calendarDays(month: string) {
  const first = Temporal.PlainDate.from(month + "-01");
  const start = first.subtract({ days: first.dayOfWeek - 1 });
  const count = Math.ceil((first.dayOfWeek - 1 + first.daysInMonth) / 7) * 7;
  return Array.from({ length: count }, (_, index) => start.add({ days: index }).toString());
}

/** 内容名称避免重复显示相同包名和标题，完整文案仍可在编辑器查看。 */
function entryLabel(entry: Entry) { return entry.title === entry.name ? entry.name : entry.name + " · " + entry.title; }

/** 月历中事件是原生按钮，键盘和触屏均直接打开同一个单项编辑器。 */
function CalendarEvent({ entry, editingId, busy, edit, compact = false }: { entry: Entry; compact?: boolean } & Pick<Props, "editingId" | "busy" | "edit">) {
  const descriptionId = useId();
  return <><button type="button" className={"publishing-plan-event " + (compact ? "is-compact " : "") + (editingId === entry.item.packageId ? "is-editing" : "")} aria-label={"编辑发布包 " + entry.name} aria-describedby={descriptionId} aria-expanded={editingId === entry.item.packageId} disabled={busy} title={entryLabel(entry)} onClick={() => edit(entry.item)}>
    <time dateTime={entry.item.excluded ? undefined : entry.item.publishAt}>{entry.item.excluded ? "暂不发布" : entry.time || "完成后"}</time><span>{entryLabel(entry)}</span>{!entry.item.excluded && entry.item.scheduleSource === "manual" && <small>手动</small>}
  </button><span className="sr-only" id={descriptionId}>{entry.item.excluded ? "暂不发布" : entry.day + " " + entry.time}，{entry.title}</span></>;
}

/** 日程每页最多25条；窄屏直接读日期清单，避免把视频名挤进七列小格。 */
function Agenda({ entries, editingId, busy, edit, page, change, showYear = false }: { entries: Entry[]; page: number; showYear?: boolean; change(value: number): void } & Pick<Props, "editingId" | "busy" | "edit">) {
  const current = Math.min(page, Math.max(0, Math.ceil(entries.length / PACKAGE_PAGE_SIZE) - 1));
  const groups = new Map<string, Entry[]>();
  for (const entry of entries.slice(current * PACKAGE_PAGE_SIZE, (current + 1) * PACKAGE_PAGE_SIZE)) {
    const day = entry.item.excluded ? "excluded" : entry.day;
    const group = groups.get(day) || []; group.push(entry); groups.set(day, group);
  }
  return <div className="publishing-plan-agenda" aria-label="排期列表">
    {[...groups].map(([day, items]) => <section key={day} data-date={day} aria-label={day === "excluded" ? "暂不发布" : day || "未分配时间"}>
      <h3><time dateTime={day && day !== "excluded" ? day : undefined}>{day === "excluded" ? "暂不发布" : day ? (showYear ? day.slice(0, 4) + "年" : "") + day.slice(5).replace("-", "月") + "日 · 周" + weekdays[Temporal.PlainDate.from(day).dayOfWeek - 1] : "未分配时间"}</time></h3>
      {items.map(entry => <article className="publishing-plan-item" key={entry.item.packageId}><CalendarEvent entry={entry} editingId={editingId} busy={busy} edit={edit} /></article>)}
    </section>)}
    {!entries.length && <p className="publishing-plan-no-events">本月暂无排期</p>}
    <Pagination page={current} total={entries.length} change={change} />
  </div>;
}

/** 初始定位首条视频所在月份；月历、全批列表与移动端日程都使用同一份Plan数据。 */
export default function PlanCalendar({ plan, editingId, busy, edit }: Props) {
  const entries = entriesFor(plan); const scheduled = entries.filter(entry => !entry.item.excluded).sort((a, b) => (a.item.publishAt || "~").localeCompare(b.item.publishAt || "~"));
  const firstMonth = scheduled.find(entry => entry.day)?.day.slice(0, 7) || plan.rule.startDate.slice(0, 7);
  const ruleKey = JSON.stringify(plan.rule);
  const [selection, setSelection] = useState({ ruleKey, month: firstMonth }); const [view, setView] = useState<"calendar" | "list">("calendar");
  const month = selection.ruleKey === ruleKey ? selection.month : firstMonth;
  const [page, setPage] = useState(0); const [excludedPage, setExcludedPage] = useState(0); const [expandedDay, setExpandedDay] = useState<string>();
  const currentMonth = Temporal.PlainDate.from(month + "-01");
  const monthlyEntries = scheduled.filter(entry => entry.day.slice(0, 7) === month);
  const excluded = entries.filter(entry => entry.item.excluded);
  const groups = new Map<string, Entry[]>();
  for (const entry of monthlyEntries) { const group = groups.get(entry.day) || []; group.push(entry); groups.set(entry.day, group); }
  /** 导航月份只改变视图；未保存的编辑内容由确认页继续持有。 */
  function navigate(delta: number) { setSelection({ ruleKey, month: currentMonth.add({ months: delta }).toString().slice(0, 7) }); setPage(0); setExpandedDay(undefined); }
  /** 切换展示形式保留排期和当前编辑，只重置清单页码。 */
  function chooseView(next: "calendar" | "list") { setView(next); setPage(0); }
  return <div className="publishing-plan-calendar" data-view={view}>
    <div className="publishing-plan-calendar-toolbar">
      {view === "calendar" ? <div className="publishing-plan-month-controls">
        <button type="button" aria-label="上个月" onClick={() => navigate(-1)}>‹</button>
        <h3 aria-live="polite">{currentMonth.year} 年 {currentMonth.month} 月</h3>
        <button type="button" aria-label="下个月" onClick={() => navigate(1)}>›</button>
        <button type="button" className="btn-ghost" aria-label="首条视频" onClick={() => { setSelection({ ruleKey, month: firstMonth }); setPage(0); setExpandedDay(undefined); }}>首条</button>
      </div> : <h3>全部视频</h3>}
      <div className="publishing-plan-view-controls"><span className="publishing-plan-timezone">{plan.rule.timezone}</span><div role="group" aria-label="排期视图">
        <button type="button" aria-pressed={view === "calendar"} onClick={() => chooseView("calendar")}>日历</button><button type="button" aria-pressed={view === "list"} onClick={() => chooseView("list")}>列表</button>
      </div></div>
    </div>
    {view === "calendar" ? <>
      <div className="publishing-plan-month" role="group" aria-label="发布排期日历">
        {weekdays.map(day => <div className="publishing-plan-weekday" key={day}>周{day}</div>)}
        {calendarDays(month).map(day => {
          const outside = day.slice(0, 7) !== month; const items = groups.get(day) || []; const expanded = expandedDay === day;
          return <div className={"publishing-plan-day " + (outside ? "is-outside" : "")} key={day} data-date={day} role="group" aria-label={day}>
            <time className="publishing-plan-date" dateTime={day}>{Number(day.slice(8))}</time>
            {(expanded ? items : items.slice(0, 3)).map(entry => <CalendarEvent key={entry.item.packageId} entry={entry} compact editingId={editingId} busy={busy} edit={edit} />)}
            {items.length > 3 && <button type="button" className="publishing-plan-more btn-ghost" aria-expanded={expanded} aria-label={expanded ? "收起 " + day + " 的排期" : "查看 " + day + " 的全部排期"} onClick={() => setExpandedDay(expanded ? undefined : day)}>{expanded ? "收起" : "+ " + (items.length - 3) + " 条"}</button>}
          </div>;
        })}
      </div>
      <div className="publishing-plan-mobile-agenda"><Agenda entries={monthlyEntries} editingId={editingId} busy={busy} edit={edit} page={page} change={setPage} /></div>
      {excluded.length > 0 && <details className="publishing-details publishing-plan-excluded"><summary>暂不发布 · {excluded.length} 条</summary><Agenda entries={excluded} editingId={editingId} busy={busy} edit={edit} page={excludedPage} change={setExcludedPage} /></details>}
    </> : <Agenda entries={entries} editingId={editingId} busy={busy} edit={edit} page={page} change={setPage} showYear />}
  </div>;
}
