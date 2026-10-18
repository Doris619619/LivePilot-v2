/** 集中编辑当前实例的持久互动偏好；保存完整聊天偏好，保持已读取的启停状态。 */
"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import { targetKey } from "@/shared/remote";
import { liveChatConfigSchema, type LiveChatConfig, type LiveChatStatus } from "@/shared/live-chat";
import { api } from "../client-request";
import styles from "./live-chat-panel.module.css";
import LiveChatFields from "./live-chat-fields";
import LiveChatPreview from "./live-chat-preview";

/** 读取失败不提供虚构的默认值；目标切换由父组件重新挂载以隔离草稿和异步结果。 */
export default function LiveChatSettings({ instance, offline, onSaving }: { instance: InstanceDescriptor; offline: boolean; onSaving: (value: boolean) => void }) {
  const [status, setStatus] = useState<LiveChatStatus>();
  const [draft, setDraft] = useState<LiveChatConfig>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { id, agentId } = instance;
  useEffect(() => {
    if (offline) return;
    const abort = new AbortController();
    api<LiveChatStatus>("/api/live-chat", { method: "POST", signal: abort.signal, timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "read", instanceId: id, ...(agentId ? { agentId } : {}) }) })
      .then(result => { if (!abort.signal.aborted) setStatus(result); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "无法读取互动设置，请重试。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, agentId, offline, revision]);
  const config = draft || status?.config;
  /** 显式保存已编辑字段；成功后通知原运行面板，避免它继续使用旧配置执行启停。 */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !config || !status || offline) return;
    const parsed = liveChatConfigSchema.safeParse({ ...config, enabled: status.config.enabled, intervalSeconds: config.intervalSeconds });
    if (!parsed.success) { setError("发送间隔请输入 5–60 的整数，人设描述最多 2000 字符。"); return; }
    setSaving(true); onSaving(true); setError(""); setMessage("");
    try {
      const result = await api<LiveChatStatus>("/api/live-chat", { method: "POST", timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "configure", instanceId: id, ...(agentId ? { agentId } : {}), config: parsed.data }) });
      setStatus(result); setDraft(undefined); setMessage("互动设置已保存，直播期间立即生效。");
      window.dispatchEvent(new CustomEvent("livenest-chat-settings-saved", { detail: { target: targetKey(instance), status: result } }));
    } catch (e) { setError(e instanceof Error ? e.message : "保存未确认，请重新读取状态后核对。"); }
    finally { setSaving(false); onSaving(false); }
  }
  return <section className="api-service-section" aria-label="互动人设与频率" aria-busy={loading && !offline || saving}>
    {offline ? <p role="status">直播电脑离线，暂时无法读取或修改互动偏好。</p> : loading ? <p role="status">正在读取互动设置…</p> : config && <form className={styles.form + " api-chat-form"} onSubmit={event => void save(event)}>
      <LiveChatFields id={`settings-${agentId || "local"}-${id}`} value={config} hideEnable disabled={saving} onChange={setDraft} />
      <LiveChatPreview key={JSON.stringify(config)} config={config} instanceId={id} agentId={agentId} disabled={saving || offline} />
      <div className="api-settings-actions"><button className="btn-primary" type="submit" disabled={saving || !draft}>{saving ? "保存中…" : "保存互动设置"}</button></div>
    </form>}
    {error && <div role="alert"><p>{error}</p>{!offline && <button type="button" disabled={saving || loading} onClick={() => { setError(""); setLoading(true); setRevision(value => value + 1); }}>重新读取互动设置</button>}</div>}
    {message && <p role="status" className="api-settings-success">{message}</p>}
    <details className="api-settings-help"><summary>互动说明</summary><ul><li>在工作台启停，关闭网页后继续运行；偏好按频道保存，直播期间修改立即生效。</li><li>回复跟随观众语言并称呼观众，不强制添加 [AI] 前缀。</li><li>使用账号 AI 服务设置，受服务余额和 YouTube 共享配额限制。</li><li>队列最多 100 条；超过 2 分钟或溢出的旧留言会跳过。<a href="https://developers.google.com/youtube/v3/determine_quota_cost" target="_blank" rel="noopener noreferrer">查看配额说明</a></li></ul></details>
  </section>;
}
