/** 发布包检查和每周计划表单：问题优先分页，发布时间与发布配置分开。 */
"use client";
import { useState } from "react";
import type { PackageBatch, PublishingPlanRule } from "@/shared/publishing";
export const PACKAGE_PAGE_SIZE = 25;
const days = ["一", "二", "三", "四", "五", "六", "日"];
/** 所有长清单统一每页25条，避免100个发布包形成无限页面。 */
export function Pagination({ page, total, change }: { page: number; total: number; change(value: number): void }) {
  const count = Math.max(1, Math.ceil(total / PACKAGE_PAGE_SIZE)); const current = Math.min(page, count - 1);
  return count > 1 ? <div className="publishing-pagination"><span>{current + 1} / {count} 页 · {total} 条</span><div><button aria-label="上一页" disabled={current === 0} onClick={() => change(current - 1)}>上一页</button><button aria-label="下一页" disabled={current >= count - 1} onClick={() => change(current + 1)}>下一页</button></div></div> : null;
}
/** 无效发布包只能经用户明确排除后继续；它们始终列在正常包前面。 */
export function PackageReview({ batch, excluded, change }: { batch: PackageBatch; excluded: string[]; change(ids: string[]): void }) {
  const [page, setPage] = useState(0);
  const ordered = [...batch.packages].sort((a, b) => Number(a.validationState === "valid") - Number(b.validationState === "valid"));
  const invalid = batch.packages.filter(p => p.validationState === "invalid").length;
  return <section aria-label="检查发布包">
    <div className="publishing-section-heading"><h2>{batch.name}</h2><span>{batch.packages.length} 个发布包 · {invalid} 个异常</span></div>
    {batch.issues.map((issue, index) => <p className="publishing-warning" role="alert" key={index}>{issue}</p>)}
    <div className="publishing-package-list">{ordered.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE).map(item => <article className={"publishing-package-row " + (item.validationState === "invalid" ? "is-invalid" : "")} key={item.id}>
      <div className="publishing-package-name"><strong>{item.name}</strong><span>{item.validationState === "valid" ? ["视频", item.sourceMusic && "音乐", item.cover && "封面"].filter(Boolean).join(" + ") : item.issues.join("；")}</span></div>
      <span className={"publishing-status " + (item.validationState === "invalid" ? "state-failed" : "state-completed")}>{item.validationState === "valid" ? "正常" : "有问题"}</span>
      <label className="publishing-check"><input type="checkbox" checked={excluded.includes(item.id)} onChange={e => change(e.target.checked ? [...excluded, item.id] : excluded.filter(id => id !== item.id))} />暂不发布<span className="sr-only">{item.name}</span></label>
    </article>)}</div>
    <Pagination page={page} total={ordered.length} change={setPage} />
  </section>;
}
/** 每个星期保留独立时间数组，支持同一天添加多个时刻。 */
export function WeeklySchedule({ rule, change }: { rule: PublishingPlanRule; change(value: PublishingPlanRule): void }) {
  /** 一次只修改指定weekday，其他星期和人工任务覆盖保持不变。 */
  function times(weekday: number, values: string[]) { change({ ...rule, weeklySlots: [...rule.weeklySlots.filter(s => s.weekday !== weekday), ...values.map(time => ({ weekday, time }))].sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time)) }); }
  return <fieldset className="publishing-weekly"><legend>每周发布时间</legend>
    {days.map((day, index) => {
      const weekday = index + 1; const entries = rule.weeklySlots.filter(s => s.weekday === weekday);
      return <div className="publishing-weekly-row" key={day}><label className="publishing-check"><input type="checkbox" checked={entries.length > 0} onChange={e => times(weekday, e.target.checked ? ["18:00"] : [])} />周{day}</label><div className="publishing-weekly-times">
        {entries.map((slot, position) => <div key={position}><input aria-label={"周" + day + "发布时间" + (position ? " " + (position + 1) : "")} type="time" required value={slot.time} onChange={e => times(weekday, entries.map((s, at) => at === position ? e.target.value : s.time))} />{entries.length > 1 && <button type="button" className="btn-ghost" aria-label={"删除周" + day + "时间 " + (position + 1)} onClick={() => times(weekday, entries.filter((_, at) => at !== position).map(s => s.time))}>×</button>}</div>)}
        {entries.length > 0 && <button type="button" className="btn-ghost" aria-label={"周" + day + "添加时间"} onClick={() => times(weekday, [...entries.map(s => s.time), "20:00"])}>+</button>}
      </div></div>;
    })}
    <div className="publishing-fields"><label>开始日期<input type="date" required value={rule.startDate} onChange={e => change({ ...rule, startDate: e.target.value })} /></label><label>时区<input required list="publishing-plan-timezones" value={rule.timezone} onChange={e => change({ ...rule, timezone: e.target.value })} /></label></div><datalist id="publishing-plan-timezones">{["America/Los_Angeles", "America/New_York", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "UTC"].map(zone => <option key={zone}>{zone}</option>)}</datalist>
  </fieldset>;
}
