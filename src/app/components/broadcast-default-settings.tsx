/** 账号级直播默认值编辑器；仅新草稿初始化使用，不追写已有直播。 */
"use client";
import { useEffect, useState } from "react";
import { api } from "../client-request";
import type { BroadcastDefaults } from "@/shared/broadcast-options";
import BroadcastRuleFields from "./broadcast-rule-fields";
import { useSettingsDraft } from "./settings-drafts";
import { SettingsActions } from "./settings-panel";
type Record = { revision: number; value: BroadcastDefaults };
/** 加载失败保留错误而非显示假默认值，保存采用乐观修订。 */
export default function BroadcastDefaultSettings({ onSaving }: { onSaving(value: boolean): void }) {
  const [record, setRecord] = useState<Record>();
  const [draft, setDraft] = useState<BroadcastDefaults>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  useSettingsDraft("broadcast-defaults", !!draft && JSON.stringify(draft) !== JSON.stringify(record?.value));
  useEffect(() => {
    const abort = new AbortController();
    void api<Record>("/api/broadcast-defaults", { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setRecord(value); }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "读取失败"); });
    return () => abort.abort();
  }, [refresh]);
  /** 保存成功后清空编辑标记；失败保留用户输入并允许核对最新版本。 */
  async function save() {
    if (!record || !draft || busy) return;
    setBusy(true); onSaving(true); setError(""); setNotice("");
    try { const result = await api<Record>("/api/broadcast-defaults", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ revision: record.revision, value: draft }) }); setRecord(result); setDraft(undefined); setNotice("默认参数已保存，供新建直播使用。"); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); onSaving(false); }
  }
  return <section className="api-service-section" aria-label="默认参数"><p className="field-hint">用于本账号新建直播；已有草稿和正在进行的直播保持原设置。</p>
    {record ? <><BroadcastRuleFields id="account-defaults" value={draft || record.value} disabled={busy} onChange={setDraft} /><SettingsActions><button type="button" className="btn-primary" disabled={busy || !draft} onClick={() => void save()}>保存默认参数</button></SettingsActions></> : !error && <p role="status">读取默认参数…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => { setError(""); setRefresh(value => value + 1); }}>重新读取默认参数</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
