/** 四步发布向导：本地批次检查、独立时间设置、持久计划确认和自动执行。 */
"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { planRuleSchema, type PackageBatch, type PublishingPlan, type PublishingPlanItem, type PublishingPlanRule, type PublishingProfile, type VideoJob } from "@/shared/publishing";
import type { PublishingTarget } from "./profile-editor";
import PlanConfirm from "./plan-confirm";
import { PackageReview, WeeklySchedule } from "./package-setup";
import BatchExecution, { type JobOperation } from "./batch-execution";
import { visibilityLabel } from "./display";
const steps = ["准备素材", "设置时间", "确认计划", "自动执行"];
type Props = {
  username: string; target: PublishingTarget; root: string; batches: PackageBatch[]; profiles: PublishingProfile[]; profileId: string; selectProfile(id: string): void;
  plans: PublishingPlan[]; jobs: VideoJob[]; allJobs?: VideoJob[]; busy: boolean; accepted: boolean; enabled: boolean; publicVerified: boolean; scan(): Promise<void>; newProfile(): void;
  preview(profileId: string, batchId: string, rule: PublishingPlanRule, items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>;
  update(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]): Promise<PublishingPlan | undefined>;
  confirm(plan: PublishingPlan, ai: boolean, replaceJobIds: string[]): Promise<boolean>; operate: JobOperation; archive(id: string): Promise<void>; viewOverview(): void;
};
/** 旧Profile的时间只作为新计划默认值，后续表单完全独立。 */
function initialRule(profile?: PublishingProfile): PublishingPlanRule {
  const timezone = profile?.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return { timezone, startDate: new Date().toLocaleDateString("en-CA", { timeZone: timezone }), weeklySlots: (profile?.schedule.weekdays || [1, 3, 5, 7]).map(weekday => ({ weekday, time: profile?.schedule.localTime || "18:00" })), preuploadDays: profile?.schedule.preuploadDays || 28 };
}
/** 只恢复同一账号/设备的非敏感表单，Cloud草稿在组件初始化时优先。 */
function readDraft(key: string) {
  try {
    if (typeof window === "undefined") return undefined;
    const value = JSON.parse(localStorage.getItem(key) || "null") as { batchId?: string; profileId?: string; rule?: PublishingPlanRule; excluded?: string[]; step?: number } | null;
    if (!value || typeof value !== "object") return undefined;
    return { batchId: typeof value.batchId === "string" ? value.batchId : "", profileId: typeof value.profileId === "string" ? value.profileId : "", rule: planRuleSchema.safeParse(value.rule).success ? value.rule : undefined, excluded: Array.isArray(value.excluded) ? value.excluded.filter(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) : [], step: value.step === 2 ? 2 : 1 };
  } catch { return undefined; }
}
/** 同账号、同设备实例恢复草稿；服务端未确认计划优先于本地表单。 */
export default function PublishingWizard(props: Props) {
  const { target, profiles, batches, plans, jobs, busy } = props;
  const storageKey = "livenest-publishing-draft:" + props.username + ":" + target.agentId + ":" + target.instanceId + (target.accountId ? ":" + target.accountId : "");
  const [cached] = useState(() => readDraft(storageKey));
  const restored = [...plans].filter(plan => !plan.confirmedAt && !plan.archivedAt && plan.profile.agentId === target.agentId && plan.profile.instanceId === target.instanceId).sort((a, b) => b.createdAt - a.createdAt)[0];
  const [plan, setPlan] = useState<PublishingPlan | undefined>(restored); const [step, setStep] = useState(restored ? restored.profile.privacy === "public" && !restored.profile.scheduled ? 2 : 3 : 1);
  const [unlockedStep, setUnlockedStep] = useState(restored ? restored.profile.privacy === "public" && !restored.profile.scheduled ? 2 : 3 : 1);
  const [batchId, setBatchId] = useState(restored?.batch.id || cached?.batchId || ""); const [excluded, setExcluded] = useState<string[]>(restored?.items.filter(item => item.excluded).map(item => item.packageId) || cached?.excluded || []);
  const [rule, setRule] = useState<PublishingPlanRule>(restored?.rule || cached?.rule || initialRule(profiles.find(profile => profile.id === props.profileId) || profiles[0]));
  const [copied, setCopied] = useState(false); const [copyError, setCopyError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const batch = batches.find(value => value.id === batchId) || (plan?.batch.id === batchId ? plan.batch : batchId ? undefined : batches[0]);
  const selectedProfile = profiles.find(value => value.id === (props.profileId || restored?.profile.id || cached?.profileId)) || profiles[0];
  const profile = selectedProfile?.privacy === "public" ? { ...selectedProfile, scheduled: true } : selectedProfile;
  const currentPlan = plan && (plans.find(value => value.id === plan.id && value.revision >= plan.revision) || plan);
  const publishingRoot = props.root.replace(/[\\/]+$/, ""); const inboxPath = /[\\/]Inbox$/i.test(publishingRoot) ? publishingRoot : publishingRoot ? publishingRoot + (publishingRoot.includes("\\") ? "\\Inbox" : "/Inbox") : "";
  const invalid = batch?.packages.filter(item => item.validationState === "invalid" && !excluded.includes(item.id)) || [];
  const included = batch?.packages.filter(item => !excluded.includes(item.id)) || [];
  const validRule = planRuleSchema.safeParse(rule).success && new Set(rule.weeklySlots.map(slot => slot.weekday + ":" + slot.time)).size === rule.weeklySlots.length;
  const contentReady = !!batch && !batch.issues.length && !invalid.length && !!included.length;
  const planMatchesInputs = !!batch && !!profile && !!currentPlan && !currentPlan.archivedAt && currentPlan.batch.id === batch.id && currentPlan.batch.version === batch.version && currentPlan.profile.id === profile.id && currentPlan.profile.revision === profile.revision && currentPlan.profile.accountId === profile.accountId && currentPlan.profile.scheduled === profile.scheduled && JSON.stringify(currentPlan.rule) === JSON.stringify(rule) && currentPlan.items.every(item => item.excluded === excluded.includes(item.packageId));
  const replacements = currentPlan ? jobs.filter(job => job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision && job.spec.contentPackage && currentPlan.items.some(item => !item.excluded && item.packageId === job.spec.contentPackage?.id) && currentPlan.batch.packages.find(item => item.id === job.spec.contentPackage?.id)?.version !== job.spec.contentPackage.version).map(job => job.spec.id) : [];
  useEffect(() => {
    try { if (plan?.confirmedAt) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, JSON.stringify({ batchId: batch?.id || batchId, profileId: profile?.id || "", rule, excluded, step: Math.min(step, 2) })); } catch { /* 浏览器禁止存储时仍可使用Cloud计划。 */ }
  }, [batch?.id, batchId, excluded, plan?.confirmedAt, profile?.id, rule, step, storageKey]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  /** 复制的是所选Agent报告的实际路径；远程浏览器不假装已打开资源管理器。 */
  async function copyPath() { try { await navigator.clipboard.writeText(inboxPath); setCopied(true); setCopyError(""); } catch { setCopyError("请选中上方路径复制。"); } }
  /** 更换批次清除此前选择，已确认旧批次仍保留在我的发布中。 */
  function chooseBatch(id: string) { setBatchId(id); setExcluded([]); setPlan(undefined); setUnlockedStep(1); }
  /** 已到达的步骤可直接返回；内容或排期变化后仍须检查/重新生成，已确认任务不进入编辑流程。 */
  function canNavigate(next: number) {
    return !busy && !currentPlan?.confirmedAt && step !== 4 && next !== step && next <= unlockedStep && (next === 1 || next === 2 && contentReady || next === 3 && contentReady && planMatchesInputs);
  }
  /** 只切换视图，不清空时间、排除项或已生成的计划。 */
  function navigate(next: number) { if (canNavigate(next)) setStep(next); }
  /** 生成或重算同一持久计划；manual条目在重新排期时原样提交。 */
  async function generate(event: FormEvent) {
    event.preventDefault(); if (!batch || !profile || profile.scheduled && !validRule || !included.length) return;
    const publishingRule = profile.scheduled || validRule ? rule : initialRule(profile);
    const items = batch.packages.map(item => ({ ...(plan?.items.find(value => value.packageId === item.id) || { packageId: item.id, scheduleSource: "auto" as const }), excluded: excluded.includes(item.id) }));
    const next = plan && !plan.confirmedAt && plan.profile.id === profile.id && plan.profile.revision === profile.revision && plan.profile.scheduled === profile.scheduled && plan.batch.id === batch.id && plan.batch.version === batch.version ? await props.update(plan, publishingRule, items) : await props.preview(profile.id, batch.id, publishingRule, items);
    if (next) { setPlan(next); setRule(next.rule); setBatchId(next.batch.id); setUnlockedStep(3); setStep(3); }
  }
  return <div className="publishing-wizard">
    <ol className="publishing-steps" aria-label="发布步骤">{steps.map((name, index) => <li className={step === index + 1 ? "is-current" : unlockedStep > index + 1 ? "is-done" : ""} key={name}><button type="button" className="publishing-step-button" aria-label={name} aria-current={step === index + 1 ? "step" : undefined} aria-controls="publishing-step-content" disabled={!canNavigate(index + 1)} onClick={() => navigate(index + 1)}><span aria-hidden="true">{index + 1}</span><span>{name}</span></button></li>)}</ol>
    <div id="publishing-step-content">
    <div className="publishing-step-heading"><h2 ref={heading} tabIndex={-1}>{steps[step - 1]}</h2><span>{step} / 4</span></div>
    {step === 1 && <>
      <div className="publishing-inbox"><p>把批次文件夹放入</p>{inboxPath ? <code>{inboxPath}</code> : <span className="publishing-hint">检测后显示设备上的发布目录。</span>}<div className="publishing-actions"><button className="btn-primary" disabled={busy || !props.accepted} onClick={() => void props.scan()}>{busy ? "检测中…" : "检测素材"}</button>{inboxPath && <button disabled={busy} onClick={() => void copyPath()}>{copied ? "已复制" : "复制路径"}</button>}</div>{copyError && <p className="publishing-validation" role="alert">{copyError}</p>}</div>
      {batches.length > 0 && <div className="publishing-batch-picker" role="group" aria-label="选择批次">{batches.map(value => <label className={"publishing-batch-choice " + (batch?.id === value.id ? "is-selected" : "")} key={value.id}><input type="radio" name="publishing-batch" checked={batch?.id === value.id} onChange={() => chooseBatch(value.id)} /><span><strong>{value.name}</strong><small>{value.packages.length} 个发布包 · {value.packages.filter(item => item.validationState === "valid").length} 正常 · {value.packages.filter(item => item.validationState === "invalid").length} 异常</small></span></label>)}</div>}
      {batch ? <><PackageReview key={batch.id} batch={batch} excluded={excluded} change={setExcluded} />{invalid.length > 0 && <p className="publishing-validation" role="status">请修好 {invalid.length} 个异常包，或勾选“暂不发布”。</p>}<div className="publishing-actions"><button className="btn-primary" disabled={busy || !contentReady} onClick={() => { setBatchId(batch.id); setUnlockedStep(Math.max(unlockedStep, 2)); setStep(2); }}>下一步</button></div></> : props.root && <div className="publishing-empty"><h3>没有批次</h3><p>复制批次到 Inbox 后，再检测。</p></div>}
    </>}
    {step === 2 && <form className="publishing-form" onSubmit={event => void generate(event)}><p className="publishing-plan-context">{batch?.name} · {included.length} 条</p>
      <label>发布频道<input readOnly value={target.channel || profile?.channelId || "尚未连接频道"} /></label>
      <div className="publishing-profile-picker"><label>发布配置<select required value={profile?.id || ""} onChange={e => props.selectProfile(e.target.value)}><option value="">请选择配置</option>{profiles.map(value => <option key={value.id} value={value.id}>{value.name} · {visibilityLabel(value.privacy === "public" ? { ...value, scheduled: true } : value)}</option>)}</select></label><button type="button" disabled={busy || !target.channelId} onClick={props.newProfile}>新建配置</button></div>
      {profile?.scheduled ? <WeeklySchedule rule={rule} change={setRule} /> : profile && <p className="publishing-hint">{visibilityLabel(profile)} · 上传完成后保存。</p>}
      {profile?.scheduled && !validRule && <p className="publishing-validation" role="alert">请选择有效时区和每周时间，重复时间请合并。</p>}
      {!props.enabled && <p className="publishing-warning">发布尚未开启，请联系管理员。</p>}{profile?.privacy === "public" && !props.publicVerified && <p className="publishing-warning">自动公开待验收，请先选择私密配置。</p>}
      <div className="publishing-actions"><button className="btn-primary" type="submit" disabled={busy || !profile || profile.scheduled && !validRule || !props.enabled || profile.privacy === "public" && !props.publicVerified}>{busy ? "生成中…" : "生成排期"}</button><button type="button" disabled={busy} onClick={() => setStep(1)}>返回素材</button></div>
    </form>}
    {step !== 4 && currentPlan && <div hidden={step !== 3}><PlanConfirm key={currentPlan.id} plan={currentPlan} channel={target.channel} busy={busy} disabled={!props.accepted || !props.enabled || currentPlan.profile.privacy === "public" && !props.publicVerified} blocked={currentPlan.archivedAt ? "这个批次已归档。" : !props.enabled ? "发布尚未开启，请联系管理员。" : currentPlan.profile.privacy === "public" && !props.publicVerified ? "自动公开待验收，请先选择私密配置。" : undefined} replacements={replacements} back={() => setStep(2)} update={async items => { const next = await props.update(currentPlan, rule, items); if (next) { setPlan(next); setExcluded(next.items.filter(item => item.excluded).map(item => item.packageId)); } return next; }} confirm={async (ai, replaceJobIds) => { if (await props.confirm(currentPlan, ai, replaceJobIds)) { setPlan({ ...currentPlan, confirmedAt: Date.now() }); setUnlockedStep(4); setStep(4); } }} /></div>}
    {step === 4 && currentPlan && <><BatchExecution plan={currentPlan} jobs={jobs.filter(job => job.spec.batchId === currentPlan.id)} allJobs={props.allJobs} busy={busy} operate={props.operate} archive={props.archive} /><div className="publishing-actions"><button className="btn-primary" onClick={props.viewOverview}>查看我的发布</button><button onClick={() => { setPlan(undefined); setBatchId(""); setExcluded([]); setUnlockedStep(1); setStep(1); }}>发布下一批</button></div></>}
    </div>
  </div>;
}
