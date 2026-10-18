/** 手动试聊预览；只保留本页八轮历史，不保存设置或发送直播。 */
"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatDecision, LiveChatConfig } from "@/shared/live-chat";
import { api } from "../client-request";

const samples = ["hi", "好好听呀", "这是什么歌", "I like it", "what is 谈何", "哈哈哈哈", "我今天有点累"];
/** 父层以 key 隔离不同设置；切换设备或草稿时取消等待并丢弃迟到结果。 */
export default function LiveChatPreview({ config, instanceId, agentId, disabled }: { config: LiveChatConfig; instanceId: string; agentId?: string; disabled?: boolean }) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<{ text: string; decision: ChatDecision }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  /** 显式操作才调用付费模型；失败保留输入，不污染对话上下文。 */
  async function preview() {
    if (!text.trim() || busy || disabled) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    const sent = text.trim();
    try {
      const decision = await api<ChatDecision>("/api/live-chat", { method: "POST", signal: controller.signal, timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "preview", instanceId, ...(agentId ? { agentId } : {}), input: { config, text: sent, history: turns.slice(-8).map(turn => ({ text: turn.text, ...(turn.decision.action !== "skip" ? { reply: turn.decision.reply } : {}) })) } }) });
      if (!controller.signal.aborted) { setTurns(previous => [...previous, { text: sent, decision }].slice(-8)); setText(""); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "试聊失败，请重试。"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <details className="chat-preview"><summary>试聊 · 不发送到直播间</summary><p>使用当前草稿，在所选直播电脑生成回复。无需开播，但设备和 AI 服务需在线；会消耗 AI 额度。更改设置会清空试聊。</p>
    <div className="chat-preview-samples">{samples.map(sample => <button type="button" key={sample} disabled={busy || disabled} onClick={() => setText(sample)}>{sample}</button>)}</div>
    <ol className="chat-preview-turns" aria-live="polite">{turns.map((turn, index) => <li key={index}><p><strong>观众：</strong>{turn.text}</p><p><strong>{turn.decision.action === "clarify" ? "澄清：" : turn.decision.action === "skip" ? "跳过：" : "回复："}</strong>{turn.decision.action === "skip" ? "这句无需接话。" : turn.decision.reply}</p></li>)}</ol>
    <label htmlFor={inputId}>模拟观众留言</label><input id={inputId} maxLength={1000} value={text} disabled={busy || disabled} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void preview(); } }} />
    <div className="api-settings-actions"><button type="button" disabled={busy || disabled || !text.trim()} onClick={() => void preview()}>{busy ? "生成中…" : "生成试聊回复"}</button><button type="button" disabled={busy || !turns.length} onClick={() => { setTurns([]); setError(""); }}>清空对话</button></div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
