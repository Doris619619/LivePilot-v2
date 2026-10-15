/** 单个 OBS 实例的 API Key 设置表单；只显示配置存在性，不读取或回显已保存的密钥。 */
"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import { aiKeySchema } from "@/shared/broadcast-ai";
import { aiServiceRequest } from "./ai-service-client";

/** 父级以目标实例为 key 挂载，切换时销毁输入；保存期间锁定目标和关闭操作。 */
export default function ApiKeySettings({ instance, offline, onSaving }: { instance: InstanceDescriptor; offline: boolean; onSaving: (value: boolean) => void }) {
  const [configured, setConfigured] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { id, agentId } = instance;
  useEffect(() => {
    if (offline) return;
    const abort = new AbortController();
    aiServiceRequest<{ configured: boolean }>({ id, agentId }, "ai-status", {}, abort.signal)
      .then(result => { if (!abort.signal.aborted) setConfigured(result.configured); })
      .catch(() => { if (!abort.signal.aborted) setError("暂时无法读取配置状态。请重试，不需要重新填写已有密钥。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, agentId, offline, revision]);
  /** 只在用户提交后保存；失败保留输入供修正，不自动重放写请求。 */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading || offline) return;
    const parsed = aiKeySchema.safeParse(key);
    if (!parsed.success) { setError("请输入 16–256 位的 API Key，仅支持字母、数字、下划线和连字符。"); return; }
    setSaving(true); onSaving(true); setError(""); setMessage("");
    try {
      const result = await aiServiceRequest<{ configured: boolean }>(instance, "ai-key", { apiKey: parsed.data });
      setConfigured(result.configured); setKey(""); setEditing(false);
      setMessage("API Key 已加密保存，下次生成时使用。");
    } catch { setError("保存结果未确认。请先刷新配置状态核对，再决定是否重新提交。"); }
    finally { setSaving(false); onSaving(false); }
  }
  /** 只重新读取配置存在性，不调用收费生成，也不改动已保存的配置。 */
  function refresh() { setLoading(true); setConfigured(undefined); setError(""); setMessage(""); setRevision(value => value + 1); }
  const showForm = editing || configured === false;
  return <section className="api-service-section" aria-labelledby="api-service-title" aria-busy={loading && !offline || saving}>
    <div className="api-service-heading"><div><h3 id="api-service-title">DeepSeek</h3><p>直播与视频发布的标题、说明生成</p></div><span className="api-config-state">{offline ? "设备离线" : loading ? "读取中…" : configured === true ? "已配置" : configured === false ? "未配置" : "状态未知"}</span></div>
    {offline ? <p role="status" className="api-settings-hint">电脑离线，暂时无法修改。上线后重新打开设置。</p> : <>
      {showForm && <form id="api-key-form" onSubmit={event => void save(event)} className="api-key-form">
        <label htmlFor="service-api-key">{configured ? "新的 API Key" : "API Key"}</label>
        <input id="service-api-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={256} value={key} onChange={event => setKey(event.target.value)} disabled={loading || saving} placeholder="粘贴 DeepSeek API Key" aria-describedby="api-key-privacy" />
        <p id="api-key-privacy" className="api-settings-hint">加密保存在直播电脑，留空保留原配置。</p>
      </form>}
      <div className="api-settings-actions">
        {showForm ? <><button type="submit" form="api-key-form" className="btn-primary" disabled={loading || saving || !key.trim()}>{saving ? "保存中…" : "保存 API Key"}</button>{editing && <button type="button" disabled={saving} onClick={() => { setKey(""); setEditing(false); setError(""); }}>取消更换</button>}</> : configured === true && <button type="button" disabled={loading || saving} onClick={() => { setEditing(true); setMessage(""); }}>更换 API Key</button>}
        <button type="button" className="btn-ghost" disabled={loading || saving} onClick={refresh}>{loading ? "正在读取…" : "刷新配置状态"}</button>
      </div>
    </>}
    {message && <p role="status" className="api-settings-success">{message}</p>}{error && <p role="alert" className="broadcast-error">{error}</p>}
    <details className="api-settings-help"><summary>配置说明</summary><ul><li>服务来自此实例的密钥或管理员配置；不显示已保存的密钥。</li><li>保存仅确认配置存在，连接与额度在生成时验证。</li><li>观众互动使用独立服务，此处更换密钥不会影响互动。</li></ul></details>
  </section>;
}
