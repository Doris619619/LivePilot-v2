/** 持久计划确认：每页25条、单项编辑、人工时间保护及可见的上传同意。 */
"use client";
import { useState } from "react";
import { UPLOAD_NOTICE, type PublishingPlan, type PublishingPlanItem } from "@/shared/publishing";
import { videoCopySchema } from "@/shared/video-metadata";
import { descriptionBytes, inputUtc, localInputTime, planTime, titleCharacters, visibilityLabel } from "./display";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
type Props = { plan: PublishingPlan; channel?: string; busy: boolean; disabled?: boolean; blocked?: string; replacements: string[]; update(items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>; confirm(ai: boolean, replacements: string[]): Promise<void>; back(): void };
/** 保存服务端返回的计划修订后才能确认，未保存的单条修改不隐式丢弃。 */
export default function PlanConfirm({ plan, channel, busy, disabled, blocked, replacements, update, confirm, back }: Props) {
  const [page, setPage] = useState(0); const [editing, setEditing] = useState<PublishingPlanItem>(); const [date, setDate] = useState("");
  const [error, setError] = useState(""); const [accepted, setAccepted] = useState(false); const [ai, setAi] = useState(false); const [replace, setReplace] = useState(false);
  const active = plan.items.filter(item => !item.excluded); const ordered = active.map(item => item.publishAt).filter((value): value is string => !!value).sort();
  const copies = new Map(plan.copies.map(copy => [copy.packageId, copy])); const packages = new Map(plan.batch.packages.map(item => [item.id, item]));
  const currentCopy = editing && copies.get(editing.packageId);
  const title = editing?.title ?? currentCopy?.title ?? ""; const description = editing?.description ?? currentCopy?.description ?? "";
  const valid = !editing || videoCopySchema.safeParse({ title, description }).success;
  const timezone = plan.rule.timezone;
  /** 一次只展开一个发布包，并以计划时区显示手工输入。 */
  function begin(item: PublishingPlanItem) { setEditing({ ...item }); setDate(item.publishAt ? localInputTime(item.publishAt, timezone) : ""); setError(""); }
  /** 日期改动成为manual，恢复auto由服务端寻找空闲时刻；其他人工覆盖原样保留。 */
  async function save() {
    if (!editing || !editing.excluded && !valid) return;
    try {
      const next = { ...editing };
      if (!next.excluded && plan.profile.scheduled && date !== (next.publishAt ? localInputTime(next.publishAt, timezone) : "")) {
        if (!date) throw new Error("请选择发布时间。"); next.publishAt = inputUtc(date, timezone); next.scheduleSource = "manual";
      }
      if (await update(plan.items.map(item => item.packageId === next.packageId ? next : item))) setEditing(undefined);
    } catch (e) { setError((e as Error).message); }
  }
  return <section aria-label="确认发布计划">
    <dl className="publishing-summary publishing-plan-summary"><div><dt>内容</dt><dd><strong>{active.length}</strong> 条{plan.items.length !== active.length && <small> · {plan.items.length - active.length} 条暂不发布</small>}</dd></div>
      {plan.profile.scheduled && <><div><dt>每周</dt><dd>{plan.rule.weeklySlots.length} 条 · 约 {Math.ceil(active.length / plan.rule.weeklySlots.length)} 周</dd></div><div><dt>首条 / 末条</dt><dd>{planTime(ordered[0], timezone)} / {planTime(ordered.at(-1), timezone)}</dd></div><div><dt>跳过已有时间</dt><dd>{plan.skippedOccupied}</dd></div></>}
    </dl>
    <p className="publishing-plan-context">{channel || plan.profile.channelId} · {visibilityLabel(plan.profile)}{plan.profile.scheduled && " · " + timezone}</p>
    {plan.profile.ai.enabled && <p className="publishing-hint">未填写的文案由 AI 生成，失败使用已确认兜底。</p>}
    <div className="publishing-plan-list">{plan.items.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE).map(item => {
      const pkg = packages.get(item.packageId); const copy = copies.get(item.packageId);
      return <article className="publishing-plan-item" key={item.packageId}><div className="publishing-plan-row"><div className="publishing-file"><h3>{pkg?.name}</h3><span>{item.title ?? copy?.title ?? pkg?.name}</span></div><div className="publishing-slot">{item.excluded ? "暂不发布" : planTime(item.publishAt, timezone)}{!item.excluded && item.scheduleSource === "manual" && <small>手动</small>}</div><button className="btn-ghost" disabled={busy || !!plan.archivedAt} aria-label={"编辑发布包 " + pkg?.name} aria-expanded={editing?.packageId === item.packageId} onClick={() => begin(item)}>修改</button></div>
        {editing?.packageId === item.packageId && <div className="publishing-inline-editor publishing-plan-editor">
          <label className="publishing-check"><input type="checkbox" checked={editing.excluded} onChange={e => setEditing({ ...editing, excluded: e.target.checked })} />暂不发布</label>
          {!editing.excluded && <>
            {plan.profile.scheduled && <label>发布时间 · {timezone}<input type="datetime-local" required value={date} onChange={e => setDate(e.target.value)} /></label>}
            <label>标题<input value={title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label><div className="publishing-field-meta"><span /><span>{titleCharacters(title)} / 100</span></div>
            <label>说明<textarea rows={3} value={description} onChange={e => setEditing({ ...editing, description: e.target.value })} /></label><div className="publishing-field-meta"><span /><span>{descriptionBytes(description)} / 5000 bytes</span></div>
            {!valid && <p className="publishing-validation" role="alert">标题最多100个字符，说明最多5000字节。</p>}
          </>}
          {error && <p className="publishing-validation" role="alert">{error}</p>}
          <div className="publishing-actions"><button className="btn-primary" disabled={busy || !editing.excluded && !valid} onClick={() => void save()}>{busy ? "保存中…" : "保存修改"}</button><button disabled={busy} onClick={() => setEditing(undefined)}>返回</button>{item.scheduleSource === "manual" && <button className="btn-ghost" disabled={busy} onClick={() => void update(plan.items.map(value => value.packageId === item.packageId ? { ...value, scheduleSource: "auto", publishAt: undefined } : value)).then(result => { if (result) setEditing(undefined); })}>恢复自动排期</button>}</div>
        </div>}
      </article>;
    })}</div>
    <Pagination page={page} total={plan.items.length} change={value => { setPage(value); setEditing(undefined); }} />
    {plan.skipped.length > 0 && <details className="publishing-details"><summary>夏令时已跳过 {plan.skipped.length} 个时刻</summary><p>{plan.skipped.join("、")}</p></details>}
    <details className="publishing-details"><summary>发布配置</summary><dl className="publishing-summary"><div><dt>配置</dt><dd>{plan.profile.name}</dd></div><div><dt>提前上传</dt><dd>{plan.rule.preuploadDays} 天</dd></div><div><dt>儿童内容</dt><dd>{plan.profile.madeForKids ? "是" : "否"}</dd></div></dl></details>
    {blocked && <p className="publishing-warning" role="status">{blocked}</p>}
    <div className="publishing-consent"><p>{UPLOAD_NOTICE}</p><div className="publishing-legal-links"><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a><a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/" target="_blank" rel="noreferrer">Community Guidelines</a></div>
      <label className="publishing-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />确认频道、内容和时间；同意临时私密标题，完成后恢复文案。</label>
      {plan.profile.ai.enabled && <label className="publishing-check"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} />同意 AI 生成文案及失败兜底。</label>}
      {replacements.length > 0 && <label className="publishing-check"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />使用新内容创建新视频（原视频保留）。</label>}
    </div>
    <div className="publishing-actions"><button className="btn-primary" disabled={busy || disabled || !!plan.archivedAt || !accepted || !!editing || !active.length || plan.profile.ai.enabled && !ai || replacements.length > 0 && !replace} onClick={() => void confirm(ai, replace ? replacements : [])}>{busy ? "提交中…" : "确认上传并按计划发布"}</button><button disabled={busy} onClick={back}>返回设置</button></div>
  </section>;
}
