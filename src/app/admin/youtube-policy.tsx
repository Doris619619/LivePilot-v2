/** 管理员预算与分日基线草稿：换日保留输入，离页保护，错误就地关联到具体字段。 */
"use client";
import { useRef, useState, type FormEvent } from "react";
import { type YouTubePolicyUpdate, type YouTubeUsageSummary } from "@/shared/youtube-usage";
import { api } from "../client-request";
import { confirmDiscardChanges, useUnsavedChanges } from "../use-unsaved-changes";
import { policyFields, policyInputValues, validatePolicyInput, type PolicyErrors } from "./youtube-policy-model";
import styles from "./youtube-usage.module.css";
type Baseline = { units: string; uploads: string; source: "google-console" | "conservative-estimate" };
const emptyBaseline: Baseline = { units: "", uploads: "", source: "google-console" };

/** 项目政策不随配额日重置；每个日期保留独立基线草稿，后台轮询不能覆盖已编辑字段。 */
export default function YouTubePolicyEditor({ summary, updated }: { summary: YouTubeUsageSummary; updated: (summary: YouTubeUsageSummary) => void }) {
  const [draft, setDraft] = useState({ policy: policyInputValues(summary.policy), original: policyInputValues(summary.policy), revision: summary.policyRevision });
  const [baselines, setBaselines] = useState<Record<string, Baseline>>({});
  const baseline = baselines[summary.day] || emptyBaseline;
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [failed, setFailed] = useState(false);
  const [errors, setErrors] = useState<PolicyErrors>({});
  const policyForm = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(draft.policy) !== JSON.stringify(draft.original); const conflict = draft.revision !== summary.policyRevision;
  const baselineDirty = Object.values(baselines).some(value => value.units !== "" || value.uploads !== "" || value.source !== "google-console");
  useUnsavedChanges(dirty || baselineDirty);
  if (conflict && !dirty) setDraft({ policy: policyInputValues(summary.policy), original: policyInputValues(summary.policy), revision: summary.policyRevision });

  /** 只修改当前日期的基线；换日和浏览器返回时仍可恢复其他日期的输入。 */
  function changeBaseline(patch: Partial<Baseline>) {
    setBaselines(current => ({ ...current, [summary.day]: { ...(current[summary.day] || emptyBaseline), ...patch } }));
  }
  /** 成功只清除已保存的基线；迟到的旧日结果由父级按当前日期筛选。 */
  async function save(update: YouTubePolicyUpdate) {
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const next = await api<YouTubeUsageSummary>("/api/admin/youtube-usage/policy", { method: "PUT", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(update) });
      if (update.policy) setDraft({ policy: policyInputValues(next.policy), original: policyInputValues(next.policy), revision: next.policyRevision });
      if (update.baseline) setBaselines(current => { const remaining = { ...current }; delete remaining[update.baseline!.day]; return remaining; });
      updated(next); setNotice("已保存。新的请求按此预算准入。");
    } catch (error) { setFailed(true); setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  /** 跨字段约束错误在字段旁展示；浏览器原生校验继续处理 required、min、max。 */
  function submitPolicy(event: FormEvent) {
    event.preventDefault(); const result = validatePolicyInput(draft.policy); setErrors(result.errors);
    if (!result.policy) {
      setFailed(true); setNotice("请修正标记的预算后重新保存。");
      const first = policyFields.find(field => result.errors[field.key]);
      requestAnimationFrame(() => { if (first) policyForm.current?.querySelector<HTMLInputElement>('[name="' + first.key + '"]')?.focus(); });
      return;
    }
    void save({ policy: result.policy, policyRevision: draft.revision });
  }
  /** 明确确认后才放弃项目政策草稿；其他日期的基线输入继续保留。 */
  async function reloadPolicy() {
    if (!confirmDiscardChanges(dirty)) return;
    setBusy(true);
    try { const next = await api<YouTubeUsageSummary>("/api/admin/youtube-usage?day=" + encodeURIComponent(summary.day)); setDraft({ policy: policyInputValues(next.policy), original: policyInputValues(next.policy), revision: next.policyRevision }); setErrors({}); updated(next); setNotice("已载入最新政策。"); setFailed(false); }
    catch (error) { setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  /** 仅保存当前配额日的显式基线；零也是一次主动确认。 */
  function submitBaseline(event: FormEvent) {
    event.preventDefault(); const units = Number(baseline.units); const uploads = Number(baseline.uploads);
    if (baseline.units === "" || baseline.uploads === "" || !Number.isInteger(units) || !Number.isInteger(uploads) || units < 0 || uploads < 0) { setFailed(true); setNotice("请输入非负整数的已用 units 和上传次数。"); return; }
    void save({ baseline: { day: summary.day, units, uploads, source: baseline.source } });
  }
  return <details className={styles.policy}><summary>配额政策与当日基线</summary><div className={styles.policyForms}>
    <form ref={policyForm} onSubmit={submitPolicy} aria-busy={busy}><h3>项目预算</h3><p>当前成本版本 {summary.costVersion}。预算包含所有已接入设备；项目实际配额以 Google 控制台为准。</p>
      {conflict && dirty && <p role="alert" className={styles.warning}>其他标签或管理员已更新政策。当前草稿已保留，请核对最新政策后重新填写。</p>}
      <div className={styles.policyGrid}>{policyFields.map(field => <label key={field.key}>{field.label}<input name={field.key} aria-label={field.label} type="number" inputMode="numeric" autoComplete="off" min={field.min} max={field.max} step="1" required disabled={busy} value={draft.policy[field.key]} aria-invalid={!!errors[field.key]} aria-describedby={errors[field.key] ? "policy-error-" + field.key : undefined} onChange={event => { setDraft(current => ({ ...current, policy: { ...current.policy, [field.key]: event.target.value } })); setErrors(current => ({ ...current, [field.key]: undefined })); }} />{errors[field.key] && <span id={"policy-error-" + field.key} className={styles.error}>{errors[field.key]}</span>}</label>)}</div>
      <button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存配额政策"}</button>{(dirty || failed) && <button type="button" disabled={busy} onClick={() => void reloadPolicy()}>载入最新政策并放弃草稿</button>}
    </form>
    <form onSubmit={submitBaseline} aria-busy={busy}><h3>{summary.day} 已用基线</h3><p>记录接入计量前的消耗。未知基线会阻止新调用；本应用预计用量不能反推 Google 实扣。</p>
      <label>此前已用通用 units<input name="baselineUnits" type="number" inputMode="numeric" autoComplete="off" min="0" step="1" required disabled={busy} value={baseline.units} onChange={event => changeBaseline({ units: event.target.value })} /></label>
      <label>此前已上传次数<input name="baselineUploads" type="number" inputMode="numeric" autoComplete="off" min="0" step="1" required disabled={busy} value={baseline.uploads} onChange={event => changeBaseline({ uploads: event.target.value })} /></label>
      <label>数据来源<select name="baselineSource" autoComplete="off" value={baseline.source} disabled={busy} onChange={event => changeBaseline({ source: event.target.value as Baseline["source"] })}><option value="google-console">Google 控制台读数</option><option value="conservative-estimate">管理员保守估计</option></select></label><button type="submit" disabled={busy}>{busy ? "正在保存…" : "确认并保存当日基线"}</button>
    </form>
    </div>{notice && <p role={failed ? "alert" : "status"} className={failed ? styles.error : styles.notice}>{notice}</p>}</details>;
}
