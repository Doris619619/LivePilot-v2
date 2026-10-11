/** 用一个风格关键词生成英文直播文案；密钥只在提交期间留于组件内存。 */
"use client";
import { useState } from "react";
import { api } from "../client-request";
import type { AiCopy } from "@/shared/broadcast-ai";
import type { InstanceDescriptor } from "@/shared/types";

/** AI 只改标题和说明，生成失败保留原文案；用户可撤销最近一次填入。 */
export default function BroadcastAi({ id, instance, disabled, current, onApply, onBusyChange }: {
  id: string; instance: InstanceDescriptor; disabled: boolean; current: AiCopy; onApply: (copy: AiCopy) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [brief, setBrief] = useState("lofi");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean>();
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [previous, setPrevious] = useState<AiCopy>();
  const locked = disabled || !!working;
  /** 不自动调用付费生成；配置查询、保存和生成均由用户点击触发。 */
  async function run(action: "ai-status" | "ai-key" | "ai-generate") {
    setWorking(action); setError(""); setMessage(""); onBusyChange(true);
    try {
      const result = await api<AiCopy & { configured?: boolean; demo?: boolean }>("/api/broadcast-assets", {
        method: "POST", timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
        body: JSON.stringify({ action, instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}), ...(action === "ai-key" ? { apiKey } : action === "ai-generate" ? { brief } : {}) }),
      });
      if (action === "ai-generate") { setPrevious(current); onApply({ title: result.title, description: result.description }); setConfigured(true); setMessage(result.demo ? "演示文案已填入，未调用真实 DeepSeek API。" : "英文文案已填入，下方可以继续修改。请核对后再开播。"); }
      else { setConfigured(result.configured); if (action === "ai-key") setApiKey(""); setMessage(action === "ai-key" ? "API Key 已加密保存，生成时验证是否可用。" : result.configured ? "此实例已配置 DeepSeek API Key。" : "此实例还没有配置 DeepSeek API Key。"); }
    } catch (e) { setError(e instanceof Error ? e.message : "请求失败，原文案已保留。"); }
    finally { setWorking(""); onBusyChange(false); }
  }
  return <div className="broadcast-ai">
    <div className="ai-heading"><strong>AI 生成英文文案</strong><span>DeepSeek</span></div>
    <label htmlFor={`ai-brief-${id}`} className="field-hint">输入音乐风格或主题，自动生成英文标题和说明。</label>
    <div className="ai-compose"><input id={`ai-brief-${id}`} value={brief} maxLength={500} placeholder="lofi / jazz / rainy Tokyo night" disabled={locked} onChange={e => setBrief(e.target.value)} /><button type="button" className="btn-secondary" disabled={locked || !brief.trim()} onClick={() => void run("ai-generate")}>{working === "ai-generate" ? "正在生成…" : "生成并填入"}</button></div>
    <details className="ai-connection"><summary>文案生成设置{configured === true ? " · 已配置" : configured === false ? " · 未配置" : ""}</summary><p className="field-hint">此密钥仅用于文案生成，不影响 AI 观众互动。也可使用管理员配置的服务；密钥加密保存且不会回显。</p><label htmlFor={`ai-key-${id}`}>API Key</label><div className="ai-compose"><input id={`ai-key-${id}`} type="password" autoComplete="new-password" spellCheck={false} value={apiKey} disabled={locked} placeholder="粘贴你的 DeepSeek API Key" onChange={e => setApiKey(e.target.value)} /><button type="button" disabled={locked || !apiKey.trim()} onClick={() => void run("ai-key")}>{working === "ai-key" ? "保存中…" : "保存 Key"}</button></div><button type="button" className="btn-ghost" disabled={locked} onClick={() => void run("ai-status")}>检查配置状态</button></details>
    {message && <p className="field-hint" role="status">{message}</p>}{error && <p className="broadcast-error" role="alert">{error}</p>}
    {previous && <button type="button" className="btn-ghost" disabled={locked} onClick={() => { onApply(previous); setPrevious(undefined); setMessage("已恢复生成前的标题和说明。"); }}>撤销填入</button>}
  </div>;
}
