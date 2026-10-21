/** 管理员编辑项目预算与当前日基线；不会把未知消耗默认为零，不重放未确认写入。 */
"use client";
import { useState, type FormEvent } from "react";
import { youtubePolicySchema, type YouTubePolicy, type YouTubePolicyUpdate, type YouTubeUsageSummary } from "@/shared/youtube-usage";
import { api } from "../client-request";
import styles from "./youtube-usage.module.css";
const fields: { key: keyof YouTubePolicy; label: string; min: number }[] = [{ key: "providerDailyUnits", label: "Google 通用每日配额", min: 100 }, { key: "dailyUnits", label: "通用每日预算", min: 100 }, { key: "controlReserve", label: "开停播预留", min: 0 }, { key: "sendUnits", label: "聊天发送上限", min: 0 }, { key: "streamUnits", label: "聊天室连接上限", min: 0 }, { key: "backgroundUnits", label: "后台状态上限", min: 0 }, { key: "unitsPerMinute", label: "每分钟 units", min: 1 }, { key: "burstUnits", label: "瞬时 units 上限", min: 50 }, { key: "searchesPerDay", label: "每日搜索次数", min: 0 }, { key: "uploadsPerDay", label: "每日上传次数", min: 0 }];
/** 政策草稿仅显式保存时提交；定时汇总不能覆盖正在编辑的输入。 */
export default function YouTubePolicyEditor({ summary, updated }: { summary: YouTubeUsageSummary; updated: (summary: YouTubeUsageSummary) => void }) {
  const [policy, setPolicy] = useState(summary.policy); const [baseline, setBaseline] = useState({ units: "", uploads: "", source: "google-console" as "google-console" | "conservative-estimate" });
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [failed, setFailed] = useState(false);
  /** 提交只采用 schema 校验的数字；失败保留草稿并要求核对，避免自动重放政策。 */
  async function save(update: YouTubePolicyUpdate) {
    setBusy(true); setNotice(""); setFailed(false);
    try { const next = await api<YouTubeUsageSummary>("/api/admin/youtube-usage/policy", { method: "PUT", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(update) }); updated(next); setNotice("已保存。新的请求按此预算准入。"); }
    catch (error) { setFailed(true); setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  /** 校验预算之间的关系后提交整个政策，已预留操作的收尾不被界面取消。 */
  function submitPolicy(event: FormEvent) { event.preventDefault(); const parsed = youtubePolicySchema.safeParse(policy); if (!parsed.success) { setFailed(true); setNotice(parsed.error.issues[0]?.message || "请检查预算范围。"); return; } void save({ policy: parsed.data }); }
  /** 当日基线必须管理员明确录入；零也是一次显式确认。 */
  function submitBaseline(event: FormEvent) { event.preventDefault(); const units = Number(baseline.units); const uploads = Number(baseline.uploads); if (baseline.units === "" || baseline.uploads === "" || !Number.isInteger(units) || !Number.isInteger(uploads) || units < 0 || uploads < 0) { setFailed(true); setNotice("请输入非负整数的已用 units 和上传次数。"); return; } void save({ baseline: { day: summary.day, units, uploads, source: baseline.source } }); }
  return <details className={styles.policy}><summary>配额政策与当日基线</summary><div className={styles.policyForms}>
    <form onSubmit={submitPolicy}><h3>项目预算</h3><p>当前成本版本 {summary.costVersion}。预算包含所有已接入设备；项目实际配额以 Google 控制台为准。</p><div className={styles.policyGrid}>{fields.map(field => <label key={field.key}>{field.label}<input type="number" min={field.min} step="1" required disabled={busy} value={policy[field.key]} onChange={event => setPolicy(current => ({ ...current, [field.key]: Number(event.target.value) }))} /></label>)}</div><button type="submit" disabled={busy}>保存配额政策</button></form>
    <form onSubmit={submitBaseline}><h3>{summary.day} 已用基线</h3><p>记录接入计量前的消耗。未知基线会阻止新调用；本应用预计用量不能反推 Google 实扣。</p><label>此前已用通用 units<input type="number" min="0" step="1" required disabled={busy} value={baseline.units} onChange={event => setBaseline(current => ({ ...current, units: event.target.value }))} /></label><label>此前已上传次数<input type="number" min="0" step="1" required disabled={busy} value={baseline.uploads} onChange={event => setBaseline(current => ({ ...current, uploads: event.target.value }))} /></label><label>数据来源<select value={baseline.source} disabled={busy} onChange={event => setBaseline(current => ({ ...current, source: event.target.value as typeof current.source }))}><option value="google-console">Google 控制台读数</option><option value="conservative-estimate">管理员保守估计</option></select></label><button type="submit" disabled={busy}>确认并保存当日基线</button></form>
    </div>{notice && <p role={failed ? "alert" : "status"} className={failed ? styles.error : styles.notice}>{notice}</p>}</details>;
}
