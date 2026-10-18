/** 手动试聊预览；只保留本页八轮历史，不保存设置或发送直播。 */
"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatDecision, LiveChatConfig } from "@/shared/live-chat";
import { api } from "../client-request";
import { chatPersonas } from "@/shared/chat-personas";

const samples = ["hi", "好好听呀", "这是什么歌", "I like it", "what is 谈何", "哈哈哈哈", "我今天有点累"];
/** 按设置快照隔离历史；更换人设保留结果，设备切换由父层 key 隔离。 */
export default function LiveChatPreview({ config, instanceId, agentId, disabled }: { config: LiveChatConfig; instanceId: string; agentId?: string; disabled?: boolean }) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<{ text: string; decision: ChatDecision; snapshot: string; persona: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const results = useRef<HTMLOListElement | null>(null);
  useEffect(() => { results.current?.scrollTo({ top: results.current.scrollHeight }); }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);
  /** 显式操作才调用付费模型；失败保留输入，不污染对话上下文。 */
  async function preview(compare = false, message = text) {
    if (!message.trim() || busy || disabled) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    const sent = message.trim();
    const snapshot = JSON.stringify(config), persona = chatPersonas[config.preset].name;
    try {
      const decision = await api<ChatDecision>("/api/live-chat", { method: "POST", signal: controller.signal, timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "preview", instanceId, ...(agentId ? { agentId } : {}), input: { config, text: sent, history: (compare ? [] : turns.filter(turn => turn.snapshot === snapshot).slice(-8)).map(turn => ({ text: turn.text, ...(turn.decision.action !== "skip" ? { reply: turn.decision.reply } : {}) })) } }) });
      if (!controller.signal.aborted) { setTurns(previous => [...previous, { text: sent, decision, snapshot, persona }].slice(-16)); setText(""); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "试聊失败，请重试。"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="chat-preview" aria-label="试聊与比较"><h4>试聊 · 不发送到直播间</h4><p>正在试用：<strong>{chatPersonas[config.preset].name}</strong>。使用当前编辑区设置，试聊不会应用到直播；需要直播电脑和 AI 服务在线，会消耗 AI 额度。</p>
    <div className="chat-preview-samples">{samples.map(sample => <button type="button" key={sample} disabled={busy || disabled} onClick={() => setText(sample)}>{sample}</button>)}</div>
    <p className="chat-preview-note">比较按钮会用当前人设重新回答同一句话，不带之前的对话；每次点击调用一次 AI。</p>
    {!turns.length && <p className="chat-preview-empty">选一句常见留言试试。切换人设后，旧回复会留下来供你比较。</p>}
    <ol ref={results} className="chat-preview-turns" aria-live="polite" tabIndex={0} aria-label="最近 16 条试聊结果">{turns.map((turn, index) => <li key={index}><small>{turn.persona} · {turn.snapshot === JSON.stringify(config) ? "当前草稿" : "先前设置"}</small><p><strong>观众：</strong>{turn.text}</p><p><strong>{turn.decision.action === "clarify" ? "澄清：" : turn.decision.action === "skip" ? "跳过：" : "回复："}</strong>{turn.decision.action === "skip" ? "这句无需接话。" : turn.decision.reply}</p><button type="button" disabled={busy || disabled} onClick={() => void preview(true, turn.text)}>用当前人设比较这句</button></li>)}</ol>
    <label htmlFor={inputId}>模拟观众留言</label><input id={inputId} maxLength={1000} value={text} disabled={busy || disabled} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void preview(); } }} />
    <div className="api-settings-actions"><button type="button" disabled={busy || disabled || !text.trim()} onClick={() => void preview()}>{busy ? "生成中…" : "生成试聊回复"}</button><button type="button" disabled={busy || !turns.length} onClick={() => { setTurns([]); setError(""); }}>清空对话</button></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
