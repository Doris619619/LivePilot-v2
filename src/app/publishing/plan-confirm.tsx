/** 持久计划确认：月历与清单共用单项编辑、人工时间保护和必要的上传同意。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { UPLOAD_NOTICE, type PublishingPlan, type PublishingPlanItem } from "@/shared/publishing";
import { videoCopySchema } from "@/shared/video-metadata";
import { descriptionBytes, inputUtc, localInputTime, planTime, titleCharacters, visibilityLabel } from "./display";
import { PACKAGE_PAGE_SIZE, Pagination } from "./package-setup";
import PlanCalendar from "./plan-calendar";
import UploadReview from "./upload-review";
import type { UploadBlock } from "./publishing-upload-review";
type Props = { plan: PublishingPlan; channel?: string; busy: boolean; disabled?: boolean; blocked?: string; scheduleOnly?: boolean; lockedPackageIds?: string[]; replacements: string[]; uploadBlockers?: UploadBlock[]; update(items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>; confirm(ai: boolean, replacements: string[]): Promise<void>; back(): void; changeMaterials?(): void; viewHistory(): void; viewExecution?(): void };

/** 保存服务端返回的计划修订后才能确认，日历切月和步骤回跳不丢弃正在编辑的字段。 */
export default function PlanConfirm({ plan, channel, busy, disabled, blocked, scheduleOnly = false, lockedPackageIds, replacements, uploadBlockers = [], update, confirm, back, changeMaterials, viewHistory, viewExecution }: Props) {
  const [page, setPage] = useState(0); const [editing, setEditing] = useState<PublishingPlanItem>(); const [date, setDate] = useState("");
  const [error, setError] = useState(""); const [accepted, setAccepted] = useState(false); const [ai, setAi] = useState(false); const [replace, setReplace] = useState(false);
  const [submissionError, setSubmissionError] = useState<{ revision: number; message: string }>();
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const active = plan.items.filter(item => !item.excluded); const ordered = active.map(item => item.publishAt).filter((value): value is string => !!value).sort();
  const copies = new Map(plan.copies.map(copy => [copy.packageId, copy])); const packages = new Map(plan.batch.packages.map(item => [item.id, item]));
  const currentCopy = editing && copies.get(editing.packageId);
  const title = editing?.title ?? currentCopy?.title ?? ""; const description = editing?.description ?? currentCopy?.description ?? "";
  const valid = scheduleOnly || !editing || videoCopySchema.safeParse({ title, description }).success;
  const timezone = plan.rule.timezone;
  /** 事件激活后将键盘焦点和页面定位移到唯一编辑区，保留月历所选月份。 */
  useEffect(() => { if (editing?.packageId) editorHeading.current?.focus(); }, [editing?.packageId]);
  /** 一次只编辑一个发布包，日期输入始终使用已确认的计划时区。 */
  function begin(item: PublishingPlanItem) { if (lockedPackageIds?.includes(item.packageId)) return; setEditing({ ...item }); setDate(item.publishAt ? localInputTime(item.publishAt, timezone) : ""); setError(""); }
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
  /** 手工恢复自动排期只清除本条固定时间，标题和说明覆盖仍由服务端保留。 */
  async function restoreAutomatic() {
    if (!editing) return;
    try {
      const result = await update(plan.items.map(item => item.packageId === editing.packageId ? { ...item, scheduleSource: "auto", publishAt: undefined } : item));
      if (result) setEditing(undefined);
    } catch (e) { setError((e as Error).message); }
  }
  /** 确认错误属于此计划修订；切换历史或后台刷新不会把它当作旧视频的执行状态。 */
  async function submit() {
    if (busy || disabled || blocked || uploadBlockers.length) return;
    setSubmissionError(undefined);
    try { await confirm(scheduleOnly ? false : ai, scheduleOnly ? [] : replace ? replacements : []); }
    catch (error) { setSubmissionError({ revision: plan.revision, message: (error as Error).message }); }
  }
  return <section aria-label="确认发布计划">
    <div className="publishing-plan-overview"><strong>{active.length} 条视频</strong><div className="publishing-plan-destination"><span>{channel || plan.profile.channelId}</span><span className="publishing-plan-visibility">{visibilityLabel(plan.profile)}</span></div></div>
    <UploadReview blockers={uploadBlockers} busy={busy} history={viewHistory} change={changeMaterials} />
    {plan.profile.scheduled ? <PlanCalendar plan={plan} editingId={editing?.packageId} busy={busy || !!plan.archivedAt} lockedPackageIds={lockedPackageIds} edit={begin} /> : <>
      <div className="publishing-plan-list">{plan.items.slice(page * PACKAGE_PAGE_SIZE, (page + 1) * PACKAGE_PAGE_SIZE).map(item => {
        const pkg = packages.get(item.packageId); const copy = copies.get(item.packageId); const label = item.title ?? copy?.title ?? pkg?.name;
        return <article className="publishing-plan-item" key={item.packageId}><div className="publishing-plan-row"><div className="publishing-file"><h3>{pkg?.name}</h3>{label !== pkg?.name && <span>{label}</span>}</div><div className="publishing-slot">{item.excluded ? "暂不发布" : "完成后"}</div>{!scheduleOnly && <button className="btn-ghost" disabled={busy || !!plan.archivedAt} aria-label={"编辑发布包 " + pkg?.name} aria-expanded={editing?.packageId === item.packageId} onClick={() => begin(item)}>修改</button>}</div></article>;
      })}</div>
      <Pagination page={page} total={plan.items.length} change={setPage} />
    </>}
    {editing && <div className="publishing-inline-editor publishing-plan-editor" role="group" aria-label={"编辑 " + packages.get(editing.packageId)?.name}>
      <div className="publishing-plan-editor-heading"><h3 ref={editorHeading} tabIndex={-1}>编辑 {packages.get(editing.packageId)?.name}</h3><button className="btn-ghost" disabled={busy} onClick={() => setEditing(undefined)}>关闭</button></div>
      {!scheduleOnly && <label className="publishing-check"><input type="checkbox" disabled={busy} checked={editing.excluded} onChange={e => setEditing({ ...editing, excluded: e.target.checked })} />暂不发布</label>}
      {!editing.excluded && <>
        {plan.profile.scheduled && <label>发布时间 · {timezone}<input type="datetime-local" disabled={busy} required value={date} onChange={e => setDate(e.target.value)} /></label>}
        {!scheduleOnly && <><label>标题<input disabled={busy} value={title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label><div className="publishing-field-meta"><span /><span>{titleCharacters(title)} / 100</span></div>
        <label>说明<textarea rows={3} disabled={busy} value={description} onChange={e => setEditing({ ...editing, description: e.target.value })} /></label><div className="publishing-field-meta"><span /><span>{descriptionBytes(description)} / 5000 bytes</span></div>
        {!valid && <p className="publishing-validation" role="alert">标题最多100个字符，说明最多5000字节。</p>}</>}
      </>}
      {error && <p className="publishing-validation" role="alert">{error}</p>}
      <div className="publishing-actions"><button className="btn-primary" disabled={busy || !editing.excluded && !valid} onClick={() => void save()}>{busy ? "保存中…" : "保存修改"}</button><button disabled={busy} onClick={() => setEditing(undefined)}>返回</button>{editing.scheduleSource === "manual" && <button className="btn-ghost" disabled={busy} onClick={() => void restoreAutomatic()}>恢复自动排期</button>}</div>
    </div>}
    <details className="publishing-details publishing-plan-details"><summary>计划详情</summary><dl className="publishing-summary">
      {plan.profile.scheduled && <><div><dt>每周</dt><dd>{plan.rule.weeklySlots.length} 条</dd></div><div><dt>首条 / 末条</dt><dd>{planTime(ordered[0], timezone)} / {planTime(ordered.at(-1), timezone)}</dd></div><div><dt>已避开占用时间</dt><dd>{plan.skippedOccupied} 个</dd></div></>}
      <div><dt>配置</dt><dd>{plan.profile.name}</dd></div><div><dt>提前上传</dt><dd>{plan.rule.preuploadDays} 天</dd></div><div><dt>儿童内容</dt><dd>{plan.profile.madeForKids ? "是" : "否"}</dd></div>
    </dl>{plan.skipped.length > 0 && <p>夏令时已跳过：{plan.skipped.join("、")}</p>}{plan.profile.ai.enabled && <p>未填写的文案由 AI 生成，失败使用已确认兜底。</p>}</details>
    {blocked && <p className="publishing-warning" role="status">{blocked}</p>}
    {!scheduleOnly && !uploadBlockers.length && <div className="publishing-consent"><p>{UPLOAD_NOTICE}</p><div className="publishing-legal-links"><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a><a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/" target="_blank" rel="noreferrer">Community Guidelines</a></div>
      <label className="publishing-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />确认频道、内容和时间；同意临时私密标题，完成后恢复文案。</label>
      {plan.profile.ai.enabled && <label className="publishing-check"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} />同意 AI 生成文案及失败兜底。</label>}
      {replacements.length > 0 && <label className="publishing-check"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />使用新内容创建新视频（原视频保留）。</label>}
    </div>}
    {submissionError?.revision === plan.revision && <p className="publishing-validation" role="alert">{submissionError.message}</p>}
    <div className="publishing-actions">{scheduleOnly ? <>
      {plan.schedulePreviewId && <button className="btn-primary" disabled={busy || disabled || !!blocked || !!plan.archivedAt || !!editing} onClick={() => void submit()}>{busy ? "提交中…" : "确认改期"}</button>}
      <button className={plan.schedulePreviewId ? "" : "btn-primary"} disabled={busy} onClick={viewExecution}>返回执行</button>
    </> : <button className="btn-primary" disabled={busy || disabled || !!blocked || !!uploadBlockers.length || !!plan.archivedAt || !accepted || !!editing || !active.length || plan.profile.ai.enabled && !ai || replacements.length > 0 && !replace} onClick={() => void submit()}>{busy ? "提交中…" : "确认上传并按计划发布"}</button>}<button disabled={busy} onClick={back}>返回设置</button></div>
  </section>;
}
