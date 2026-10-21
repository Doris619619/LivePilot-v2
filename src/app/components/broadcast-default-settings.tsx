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
  const [draft, setDraft] = useState<Record>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useSettingsDraft("broadcast-defaults", !!draft && JSON.stringify(draft.value) !== JSON.stringify(record?.value));
  useEffect(() => {
    const abort = new AbortController();
    void api<Record>("/api/broadcast-defaults", { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setRecord(value); }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "读取失败"); });
    return () => abort.abort();
  }, []);
  /** 普通重读不改变旧草稿的基准；明确放弃仅在成功取得新值后生效，读取失败仍保留全部输入。 */
  async function reload(discard = false) {
    if (busy) return; setBusy(true); onSaving(true); setError(""); setNotice("");
    try { const next = await api<Record>("/api/broadcast-defaults"); setRecord(next); if (discard) { setDraft(undefined); setNotice("已放弃草稿并载入最新默认参数。"); } }
    catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
    finally { setBusy(false); onSaving(false); }
  }
  /** 保存成功后清空编辑标记；失败保留用户输入并允许核对最新版本。 */
  async function save() {
    if (!record || !draft || busy) return;
    setBusy(true); onSaving(true); setError(""); setNotice("");
    try { const result = await api<Record>("/api/broadcast-defaults", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(draft) }); setRecord(result); setDraft(undefined); setNotice("默认参数已保存，供新建直播使用。"); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); onSaving(false); }
  }
  return <section className="api-service-section" aria-label="默认参数"><p className="field-hint">用于本账号新建直播；已有草稿和正在进行的直播保持原设置。</p>
    {record ? <>{draft && draft.revision !== record.revision && <p className="field-hint" role="status">其他窗口已更新默认参数，当前草稿保留原版本；请放弃草稿并载入最新参数后重新修改。</p>}<BroadcastRuleFields id="account-defaults" value={draft?.value || record.value} disabled={busy} onChange={value => setDraft(current => ({ revision: current?.revision ?? record.revision, value }))} /><SettingsActions><button type="button" className="btn-primary" disabled={busy || !draft} onClick={() => void save()}>保存默认参数</button>{draft && <button type="button" disabled={busy} onClick={() => void reload(true)}>放弃草稿并载入最新默认参数</button>}</SettingsActions></> : !error && <p role="status">读取默认参数…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => void reload()}>重新读取默认参数</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
