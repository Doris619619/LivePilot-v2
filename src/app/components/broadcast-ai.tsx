/** 用主题生成英文直播文案；凭据管理由独立设置区承担，失败保留草稿并支持撤销。 */
"use client";
import { useState } from "react";
import { aiServiceRequest } from "./ai-service-client";
import { ApiSettingsButton } from "./api-settings";
import type { AiCopy } from "@/shared/broadcast-ai";
import type { InstanceDescriptor } from "@/shared/types";

/** AI 只改标题和说明，生成失败保留原文案；用户可撤销最近一次填入。 */
export default function BroadcastAi({ id, instance, disabled, current, onApply, onBusyChange }: {
  id: string; instance: InstanceDescriptor; disabled: boolean; current: AiCopy; onApply: (copy: AiCopy) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [brief, setBrief] = useState("lofi");
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [previous, setPrevious] = useState<AiCopy>();
  const locked = disabled || !!working;
  /** 只在用户点击后调用生成，原文案在成功返回前保持不变。 */
  async function generate() {
    if (locked) return;
    setWorking("ai-generate"); setError(""); setMessage(""); onBusyChange(true);
    try {
      const result = await aiServiceRequest<AiCopy & { demo?: boolean }>(instance, "ai-generate", { brief });
      setPrevious(current); onApply({ title: result.title, description: result.description }); setMessage(result.demo ? "已填入演示文案 · 未调用 AI" : "已填入英文文案");
    } catch (e) { setError(e instanceof Error ? e.message : "请求失败，原文案已保留。"); }
    finally { setWorking(""); onBusyChange(false); }
  }
  return <div className="broadcast-ai">
    <label htmlFor={`ai-brief-${id}`}>文案主题</label>
    <div className="ai-compose"><input id={`ai-brief-${id}`} value={brief} maxLength={500} placeholder="lofi / jazz / rainy Tokyo night" disabled={locked} onChange={e => setBrief(e.target.value)} /><button type="button" className="btn-secondary" disabled={locked || !brief.trim()} onClick={() => void generate()}>{working ? "正在生成…" : "生成英文文案"}</button><ApiSettingsButton instance={instance} disabled={locked}>API 设置</ApiSettingsButton></div>
    {(message || previous) && <div className="ai-feedback">{message && <p className="field-hint" role="status">{message}</p>}{previous && <button type="button" className="btn-ghost" disabled={locked} onClick={() => { onApply(previous); setPrevious(undefined); setMessage("已恢复原文案"); }}>撤销填入</button>}</div>}
    {error && <p className="broadcast-error" role="alert">{error}</p>}
  </div>;
}
