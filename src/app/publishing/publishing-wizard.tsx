/** 四步发布向导：本地批次检查、独立时间设置、持久计划确认和自动执行。 */
"use client";
import WorkflowSteps from "../components/ui/workflow-steps";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { planRuleSchema, publishingTerminal, type PackageBatch, type PublishingBatchRemoval, type PublishingPlan, type PublishingPlanItem, type PublishingPlanRule, type PublishingProfile, type VideoJob } from "@/shared/publishing";
import type { BatchRemovalOperation } from "./batch-removal";
import type { PublishingTarget } from "./profile-editor";
import PlanConfirm from "./plan-confirm";
import { PackageReview, WeeklySchedule } from "./package-setup";
import BatchExecution, { type JobOperation } from "./batch-execution";
import { visibilityLabel } from "./display";
import { publishingInboxPath } from "./publishing-directory";
import { publishingInputKey, publishingPlanMatchesInputs } from "./publishing-wizard-inputs";
import { hasNewPublishingDraft, parsePublishingDraft, restorePublishingPlan } from "./publishing-wizard-draft";
const steps = ["准备素材", "设置时间", "确认计划", "自动执行"];
type Props = {
  username: string; target: PublishingTarget; root: string; batches: PackageBatch[]; profiles: PublishingProfile[]; profileId: string; selectProfile(id: string): void;
  directoryMessage?: string; directoryReading?: boolean; retryDirectory?(): void; scanned?: boolean;
  plans: PublishingPlan[]; jobs: VideoJob[]; allJobs?: VideoJob[]; busy: boolean; accepted: boolean; scan(): Promise<void>; newProfile(): void;
  removals?: PublishingBatchRemoval[]; removeBatch?: BatchRemovalOperation;
  preview(profileId: string, batchId: string, rule: PublishingPlanRule, items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>;
  update(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>;
  reschedulePreview(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>;
  rescheduleConfirm(plan: PublishingPlan): Promise<PublishingPlan | undefined>;
  confirm(plan: PublishingPlan, ai: boolean, replaceJobIds: string[]): Promise<boolean>; operate: JobOperation; archive(id: string): Promise<void>; viewOverview(): void;
};
/** 旧Profile的时间只作为新计划默认值，后续表单完全独立。 */
function initialRule(profile?: PublishingProfile): PublishingPlanRule {
  const timezone = profile?.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return { timezone, startDate: new Date().toLocaleDateString("en-CA", { timeZone: timezone }), weeklySlots: (profile?.schedule.weekdays || [1, 3, 5, 7]).map(weekday => ({ weekday, time: profile?.schedule.localTime || "18:00" })), preuploadDays: profile?.schedule.preuploadDays || 28 };
}
/** 只读取同一账号/设备的非敏感表单；明确的新批次选择不能被旧 Cloud 草稿覆盖。 */
function readDraft(key: string) {
  try {
    if (typeof window === "undefined") return undefined;
    return parsePublishingDraft(JSON.parse(localStorage.getItem(key) || "null"));
  } catch { return undefined; }
}
/** 恢复固定计划或明确的新批次草稿；未重新检测的本地选择仍从素材步骤开始。 */
export default function PublishingWizard(props: Props) {
  const { target, profiles, batches, plans, jobs, busy } = props;
  const storageKey = "livenest-publishing-draft:" + props.username + ":" + target.agentId + ":" + target.instanceId + (target.accountId ? ":" + target.accountId : "");
  const [storedDraft] = useState(() => readDraft(storageKey));
  const cached = props.removals?.some(value => value.batchId === storedDraft?.planId && value.completedAt) ? undefined : storedDraft;
  const restored = restorePublishingPlan(plans, target, cached, props.removals);
  const cachedBatch = batches.find(batch => batch.id === cached?.batchId);
  const cachedReady = !!cachedBatch && !cachedBatch.issues.length && cachedBatch.packages.some(pkg => !cached?.excluded.includes(pkg.id)) && cachedBatch.packages.every(pkg => pkg.validationState === "valid" || cached?.excluded.includes(pkg.id));
  const initialStep = restored?.confirmedAt ? cached?.step === 3 ? 2 : cached?.step || 4 : restored ? restored.profile.privacy === "public" && !restored.profile.scheduled ? 2 : 3 : cachedReady && (cached?.step || 0) >= 2 ? 2 : 1;
  const [plan, setPlan] = useState<PublishingPlan | undefined>(restored); const [schedulePreview, setSchedulePreview] = useState<PublishingPlan>(); const [step, setStep] = useState(initialStep);
  const [newDraft, setNewDraft] = useState(hasNewPublishingDraft(cached));
  const [unlockedStep, setUnlockedStep] = useState(restored?.confirmedAt ? 4 : restored ? restored.profile.privacy === "public" && !restored.profile.scheduled ? 2 : 3 : initialStep);
  const [batchId, setBatchId] = useState(restored?.batch.id || cached?.batchId || ""); const [excluded, setExcluded] = useState<string[]>(restored?.items.filter(item => item.excluded).map(item => item.packageId) || cached?.excluded || []);
  const [rule, setRule] = useState<PublishingPlanRule>(restored?.confirmedAt ? cached?.rule || restored.rule : restored?.rule || cached?.rule || initialRule(profiles.find(profile => profile.id === props.profileId) || profiles[0]));
  const [copied, setCopied] = useState(false); const [copyError, setCopyError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const committedPlan = plan && (plans.find(value => value.id === plan.id && value.revision >= plan.revision) || plan);
  const removal = props.removals?.find(value => value.batchId === committedPlan?.id); const viewStep = removal ? 4 : step;
  const confirmed = !!committedPlan?.confirmedAt;
  const currentPlan = schedulePreview || committedPlan;
  const batch = confirmed ? committedPlan.batch : batches.find(value => value.id === batchId) || (plan?.batch.id === batchId ? plan.batch : batchId ? undefined : batches[0]);
  const selectedProfile = profiles.find(value => value.id === (props.profileId || restored?.profile.id || cached?.profileId)) || profiles[0];
  const profile = confirmed ? committedPlan.profile : selectedProfile?.privacy === "public" ? { ...selectedProfile, scheduled: true } : selectedProfile;
  const inboxPath = publishingInboxPath(props.root);
  const invalid = batch?.packages.filter(item => item.validationState === "invalid" && !excluded.includes(item.id)) || [];
  const included = batch?.packages.filter(item => !excluded.includes(item.id)) || [];
  const validRule = planRuleSchema.safeParse(rule).success && new Set(rule.weeklySlots.map(slot => slot.weekday + ":" + slot.time)).size === rule.weeklySlots.length;
  const contentReady = !!batch && !batch.issues.length && !invalid.length && !!included.length;
  const inputs = { target, batch, profile, rule, excluded };
  const inputKey = publishingInputKey(inputs); const planMatchesInputs = publishingPlanMatchesInputs(currentPlan, inputs);
  const latestInput = useRef(inputKey); const requestSequence = useRef(0); const mounted = useRef(true);
  useLayoutEffect(() => { latestInput.current = inputKey; }, [inputKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const confirmationReady = !removal && props.accepted && contentReady && planMatchesInputs && (!profile?.scheduled || validRule);
  const replacements = currentPlan ? jobs.filter(job => job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision && job.spec.contentPackage && currentPlan.items.some(item => !item.excluded && item.packageId === job.spec.contentPackage?.id) && currentPlan.batch.packages.find(item => item.id === job.spec.contentPackage?.id)?.version !== job.spec.contentPackage.version).map(job => job.spec.id) : [];
  const lockedPackageIds = currentPlan?.scheduleLockedPackageIds || (confirmed ? currentPlan?.items.filter(item => {
    const job = jobs.find(job => job.spec.batchId === currentPlan.id && job.spec.contentPackage?.id === item.packageId);
    return item.excluded || !job || job.spec.desired === "cancel" || publishingTerminal(job.observed?.state) || job.observed?.state === "needs_attention";
  }).map(item => item.packageId) : undefined);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ planId: plan?.id, newDraft: !plan?.id && newDraft, batchId: batch?.id || batchId, profileId: profile?.id || "", rule, excluded, step })); } catch { /* 浏览器禁止存储时仍可使用Cloud计划。 */ }
  }, [batch?.id, batchId, excluded, newDraft, plan?.id, profile?.id, rule, step, storageKey]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  /** 复制的是所选Agent报告的实际路径；远程浏览器不假装已打开资源管理器。 */
  async function copyPath() { try { await navigator.clipboard.writeText(inboxPath); setCopied(true); setCopyError(""); } catch { setCopyError("请选中上方路径复制。"); } }
  /** 返回结果只有在同一输入和最新请求仍有效时才可进入下一步；切换设备卸载后也不采用旧响应。 */
  function responseCurrent() { const sequence = ++requestSequence.current; const snapshot = inputKey; return () => mounted.current && requestSequence.current === sequence && latestInput.current === snapshot; }
  /** 更换批次清除此前选择，已确认旧批次仍保留在我的发布中。 */
  function chooseBatch(id: string) { if (confirmed) return; setBatchId(id); setExcluded([]); setPlan(undefined); setNewDraft(true); setSchedulePreview(undefined); setUnlockedStep(1); }
  /** 已到达步骤均可回跳；确认后只查看固定素材并通过独立预览修改原任务排期。 */
  function canNavigate(next: number) {
    return !removal && !busy && next !== step && next <= unlockedStep && (confirmed ? next !== 3 || JSON.stringify(currentPlan?.rule) === JSON.stringify(rule) : next === 1 || next === 2 && contentReady || next === 3 && contentReady && planMatchesInputs);
  }
  /** 只切换视图，不清空时间、排除项或已生成的计划。 */
  function navigate(next: number) { if (canNavigate(next)) setStep(next); }
  /** 生成或重算同一持久计划；manual条目在重新排期时原样提交。 */
  async function generate(event: FormEvent) {
    event.preventDefault(); if (removal || busy || !batch || !profile || profile.scheduled && !validRule || !included.length) return;
    const current = responseCurrent();
    const publishingRule = profile.scheduled || validRule ? rule : initialRule(profile);
    const items = batch.packages.map(item => ({ ...(plan?.items.find(value => value.packageId === item.id) || { packageId: item.id, scheduleSource: "auto" as const }), excluded: excluded.includes(item.id) }));
    const next = confirmed && committedPlan ? await props.reschedulePreview(committedPlan, publishingRule, currentPlan?.items || items) : plan && plan.profile.id === profile.id && plan.profile.revision === profile.revision && plan.profile.scheduled === profile.scheduled && plan.batch.id === batch.id && plan.batch.version === batch.version ? await props.update(plan, publishingRule, items) : await props.preview(profile.id, batch.id, publishingRule, items);
    if (next && current()) { if (confirmed) setSchedulePreview(next); else setPlan(next); setRule(next.rule); setBatchId(next.batch.id); setUnlockedStep(confirmed ? 4 : 3); setStep(3); }
  }
  return <div className="publishing-wizard">
    <WorkflowSteps labels={steps} current={viewStep} reached={unlockedStep} canNavigate={canNavigate} navigate={navigate} label="发布步骤" />
    <div id="publishing-step-content">
    <div className="publishing-step-heading"><h2 ref={heading} tabIndex={-1}>{steps[viewStep - 1]}</h2><span>{viewStep} / 4</span></div>
    {viewStep === 1 && <>
      {!confirmed && <><div className="publishing-inbox"><p>{target.name} · 把批次文件夹放入</p>{inboxPath ? <code>{inboxPath}</code> : <span className="publishing-hint" role="status">{props.directoryMessage || "正在读取这台电脑的目录…"}</span>}<div className="publishing-actions"><button className="btn-primary" disabled={busy || !props.accepted} onClick={() => void props.scan()}>{busy ? "检测中…" : "检测素材"}</button>{inboxPath && <button disabled={busy} onClick={() => void copyPath()}>{copied ? "已复制" : "复制路径"}</button>}{!inboxPath && props.retryDirectory && props.accepted && !props.directoryReading && <button disabled={busy} onClick={props.retryDirectory}>重试读取目录</button>}</div><p className="publishing-hint">这台电脑的客户端：设置 → 打开发布目录。</p><details className="publishing-details publishing-folder-guide"><summary>素材怎么放</summary><pre>{"Inbox/\n  我的批次/\n    001/\n      video.mp4\n      music.mp3（可选）\n    002/\n      video.mp4"}</pre><p>每包一个视频；音乐、封面和文案可选。</p></details>{copyError && <p className="publishing-validation" role="alert">{copyError}</p>}</div>
      {batches.length > 0 && <div className="publishing-batch-picker" role="group" aria-label="选择批次">{batches.map(value => <label className={"publishing-batch-choice " + (batch?.id === value.id ? "is-selected" : "")} key={value.id}><input type="radio" name="publishing-batch" disabled={busy} checked={batch?.id === value.id} onChange={() => chooseBatch(value.id)} /><span><strong>{value.name}</strong><small>{value.packages.length} 个发布包 · {value.packages.filter(item => item.validationState === "valid").length} 正常 · {value.packages.filter(item => item.validationState === "invalid").length} 异常</small></span></label>)}</div>}</>}
      {batch ? <><PackageReview key={batch.id} batch={batch} excluded={excluded} change={setExcluded} readOnly={confirmed || busy} />{!confirmed && invalid.length > 0 && <p className="publishing-validation" role="status">请修好 {invalid.length} 个异常包，或勾选“暂不发布”。</p>}<div className="publishing-actions"><button className="btn-primary" disabled={busy || !contentReady} onClick={() => { setBatchId(batch.id); setUnlockedStep(Math.max(unlockedStep, 2)); setStep(2); }}>下一步</button>{confirmed && <button disabled={busy} onClick={() => setStep(4)}>返回执行</button>}</div></> : props.scanned && props.root && <div className="publishing-empty"><h3>没有批次</h3><p>复制批次到 Inbox 后，再检测。</p></div>}
    </>}
    {viewStep === 2 && <form className="publishing-form" onSubmit={event => void generate(event)}><p className="publishing-plan-context">{batch?.name} · {included.length} 条</p>
      <label>发布频道<input readOnly value={target.channel || profile?.channelId || "尚未连接频道"} /></label>
      <div className="publishing-profile-picker"><label>发布配置{confirmed ? <input readOnly value={profile?.name || ""} /> : <select aria-label="发布配置" required disabled={busy} value={profile?.id || ""} onChange={e => props.selectProfile(e.target.value)}><option value="">请选择配置</option>{profiles.map(value => <option key={value.id} value={value.id}>{value.name} · {visibilityLabel(value.privacy === "public" ? { ...value, scheduled: true } : value)}</option>)}</select>}</label>{!confirmed && <button type="button" disabled={busy || !target.channelId} onClick={props.newProfile}>新建配置</button>}</div>
      {profile?.scheduled ? <WeeklySchedule rule={rule} change={setRule} disabled={busy} /> : profile && <p className="publishing-hint">{visibilityLabel(profile)} · 上传完成后保存。</p>}
      {profile?.scheduled && !validRule && <p className="publishing-validation" role="alert">请选择有效时区和每周时间，重复时间请合并。</p>}
      {confirmed && profile?.scheduled && <p className="publishing-hint">只调整未完成视频，手动时间保持不变。</p>}
      <div className="publishing-actions">{(!confirmed || profile?.scheduled) && <button className="btn-primary" type="submit" disabled={busy || !profile || profile.scheduled && !validRule}>{busy ? "生成中…" : confirmed ? "预览新排期" : "生成排期"}</button>}<button type="button" disabled={busy} onClick={() => setStep(1)}>返回素材</button>{confirmed && <button type="button" disabled={busy} onClick={() => setStep(4)}>返回执行</button>}</div>
    </form>}
    {currentPlan && <div hidden={viewStep !== 3}><PlanConfirm key={currentPlan.id} plan={currentPlan} channel={target.channel} busy={busy} scheduleOnly={confirmed} lockedPackageIds={lockedPackageIds} disabled={!confirmationReady} blocked={removal ? "这个批次已请求删除。" : currentPlan.archivedAt ? "这个批次已归档。" : !planMatchesInputs ? "设置已变化，请重新生成排期。" : undefined} replacements={replacements} back={() => setStep(2)} viewExecution={() => setStep(4)} update={async items => { if (busy || !confirmationReady) return; const current = responseCurrent(); const next = confirmed && committedPlan ? await props.reschedulePreview(committedPlan, rule, items) : await props.update(currentPlan, rule, items); if (!next || !current()) return; if (confirmed) setSchedulePreview(next); else { setPlan(next); setExcluded(next.items.filter(item => item.excluded).map(item => item.packageId)); } return next; }} confirm={async (ai, replaceJobIds) => {
      if (busy || !confirmationReady) return; const current = responseCurrent();
      if (confirmed) { const next = await props.rescheduleConfirm(currentPlan); if (next && current()) { setPlan(next); setSchedulePreview(undefined); setRule(next.rule); setStep(4); } }
      else if (await props.confirm(currentPlan, ai, replaceJobIds) && current()) { setPlan({ ...currentPlan, confirmedAt: Date.now() }); setUnlockedStep(4); setStep(4); }
    }} /></div>}
    {viewStep === 4 && committedPlan && <><BatchExecution plan={committedPlan} jobs={jobs.filter(job => job.spec.batchId === committedPlan.id)} allJobs={props.allJobs} busy={busy} operate={props.operate} archive={props.archive} removal={removal} removeBatch={props.removeBatch} /><div className="publishing-actions"><button className="btn-primary" onClick={props.viewOverview}>查看我的发布</button><button onClick={() => { setPlan(undefined); setNewDraft(true); setSchedulePreview(undefined); setBatchId(""); setExcluded([]); setUnlockedStep(1); setStep(1); }}>发布下一批</button></div></>}
    </div>
  </div>;
}
