/** 账号共享 AI 设置：密钥只写不读，按用途控制。 */
"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { aiKeySchema } from "@/shared/broadcast-ai";
import type { AccountAiStatus, AiUses } from "@/shared/account-ai";
import { api } from "../client-request";
import { useSettingsDraft } from "./settings-drafts";
import { SettingsActions } from "./settings-panel";
/** 关闭时销毁输入；保存失败保留输入，可重新读取确认结果。 */
export default function ApiKeySettings({ onSaving }: { onSaving: (value: boolean) => void }) {
  const [status, setStatus] = useState<AccountAiStatus>();
  const [usesDraft, setUsesDraft] = useState<Partial<AiUses>>();
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [keyError, setKeyError] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const uses: AiUses = { ...(status?.uses || { copy: true, chat: true }), ...usesDraft };
  useSettingsDraft("account-ai", !!key || !!usesDraft && (!status || uses.copy !== status.uses.copy || uses.chat !== status.uses.chat));
  useEffect(() => {
    const abort = new AbortController();
    api<AccountAiStatus>("/api/account-ai", { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setStatus(value);
    }).catch(() => { if (!abort.signal.aborted) setError("无法读取最新 AI 设置，请重试。当前输入已保留。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [revision]);
  /** 已知字段错误紧邻密钥显示并移入焦点；网络和修订错误仍由全局反馈说明。 */
  function rejectKey(message: string) {
    setKeyError(message); setError(""); keyInput.current?.focus();
  }
  /** 修订冲突或未知结果不自动重放写请求，留空保留原 Key。 */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || saving || loading) return;
    const parsed = key.trim() ? aiKeySchema.safeParse(key.trim()) : undefined;
    if (parsed && !parsed.success) { rejectKey("API Key 格式无效，请重新复制完整密钥。"); return; }
    if (!parsed && !status.configured && (uses.copy || uses.chat)) { rejectKey("请填写 API Key，或关闭两项 AI 用途。"); return; }
    setSaving(true); onSaving(true); setError(""); setKeyError(""); setMessage("");
    try {
      const result = await api<AccountAiStatus>("/api/account-ai", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ revision: status.revision, uses, ...(parsed?.success ? { apiKey: parsed.data } : {}) }) });
      setStatus(result); setUsesDraft(undefined); setKey("");
      setMessage("已保存。在线客户端通常在 1 分钟内同步，离线设备上线后同步。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存结果未确认，请重新读取核对。"); }
    finally { setSaving(false); onSaving(false); }
  }
  /** 重读只更新公开基准，保留密钥与用途草稿；保存时继续采用最新修订。 */
  function refresh() { setLoading(true); setError(""); setMessage(""); setRevision(value => value + 1); }
  const locked = loading || saving || !status;
  return <section className="api-service-section" aria-labelledby="api-service-title" aria-busy={loading || saving}>
    <div className="api-service-heading"><div><h3 id="api-service-title">DeepSeek</h3><p>当前账号的直播与视频发布共用一个 Key。</p></div><span className="api-config-state">{loading ? "读取中…" : status?.configured ? "已保存" : status ? "未配置" : "读取失败"}</span></div>
    <form id="account-ai-form" onSubmit={event => void save(event)} className="api-key-form">
      <label htmlFor="service-api-key">{status?.configured ? "更换 API Key" : "API Key"}</label>
      <input ref={keyInput} id="service-api-key" name="apiKey" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={256} value={key} onChange={event => { setKey(event.target.value); setKeyError(""); }} disabled={locked} placeholder={status?.configured ? "留空保留已保存的 Key" : "粘贴 DeepSeek API Key"} aria-invalid={!!keyError} aria-describedby={`api-key-privacy${keyError ? " api-key-error" : ""}`} />
      {keyError && <p id="api-key-error" role="alert" className="broadcast-error">{keyError}</p>}
      <p id="api-key-privacy" className="api-settings-hint">密钥加密保存，仅下发到本账号的直播电脑，不会回显。</p>
      <fieldset className="ai-usage-fields" disabled={locked}><legend>使用范围</legend>
        <label><input name="copyEnabled" type="checkbox" checked={uses.copy} onChange={event => { const checked = event.target.checked; setUsesDraft(current => ({ ...current, copy: checked })); setKeyError(""); }} /><span>文案生成<small>生成直播和视频发布的标题、说明</small></span></label>
        <label><input name="chatEnabled" type="checkbox" checked={uses.chat} onChange={event => { const checked = event.target.checked; setUsesDraft(current => ({ ...current, chat: checked })); setKeyError(""); }} /><span>观众互动<small>允许自动回复；每场直播在「直播编排」中开启</small></span></label>
      </fieldset>
      <SettingsActions><button type="submit" form="account-ai-form" className="btn-primary" disabled={locked}>{saving ? "保存中…" : "保存设置"}</button><button type="button" className="btn-ghost" disabled={loading || saving} onClick={refresh}>重新读取</button></SettingsActions>
    </form>
    {message && <p role="status" className="api-settings-success">{message}</p>}{error && <p role="alert" className="broadcast-error">{error}</p>}
    <details className="api-settings-help"><summary>配置说明</summary><ul><li>需要支持账号 AI 服务的新版客户端。旧密钥和频道授权不会被删除。</li><li>保存表示配置已记录；连接和额度在实际使用时验证。</li></ul></details>
  </section>;
}
