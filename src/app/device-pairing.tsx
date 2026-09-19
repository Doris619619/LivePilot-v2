/** 网页添加电脑：一次性邀请只保存在当前页面，不写本地缓存或 URL。 */
"use client";
import { useState } from "react";
import { api } from "./client-request";
import type { AgentDescriptor } from "@/shared/remote";
/** 成员创建邀请并复制到桌面客户端，过期后可重发同一未绑定设备。 */
export default function DevicePairing({ agents }: { agents: AgentDescriptor[] }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState("");
  const [invitation, setInvitation] = useState(""); const [agentId, setAgentId] = useState<string>();
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const paired = !!agents.find(a => a.id === agentId)?.paired;
  /** 重试复用未使用邀请的设备 ID，已配对时服务器拒绝覆盖。 */
  async function create() {
    setBusy(true); setMessage("");
    try { const result = await api<{ agentId: string; invitation: string }>("/api/devices/pairing", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ name, agentId }) }); setAgentId(result.agentId); setInvitation(result.invitation); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="device-pairing"><button onClick={() => setOpen(!open)}>添加直播电脑</button>{open && <section className="pairing-panel" aria-label="添加直播电脑">
    <label className="field-group">设备<select value={agentId || ""} onChange={e => { const id = e.target.value; setAgentId(id || undefined); setName(agents.find(a => a.id === id)?.name || ""); setInvitation(""); setMessage(""); }}><option value="">新电脑</option>{agents.filter(a => !a.revoked && (!a.paired || a.id === agentId)).map(a => <option key={a.id} value={a.id}>{a.name}{a.paired ? "（已配对）" : "（等待配对）"}</option>)}{agentId && !agents.some(a => a.id === agentId) && <option value={agentId}>{name}</option>}</select></label>
    <label className="field-group">电脑名称<input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="导师电脑" /></label>
    <button className="btn-primary" disabled={busy || !name.trim() || paired} onClick={() => void create()}>{paired ? "已配对" : busy ? "正在生成…" : agentId ? "重新生成配对信息" : "生成配对信息"}</button>
    {invitation && <><label className="field-group">配对信息（10 分钟内有效）<textarea readOnly value={invitation} rows={4} /></label><button onClick={() => void navigator.clipboard.writeText(invitation).then(() => setMessage("已复制，请粘贴到本机 LiveNest。"), () => setMessage("请选中配对信息，按 Ctrl+C 复制。"))}>复制配对信息</button></>}
    {message && <p role="status">{message}</p>}<a href="https://github.com/Doris619619/LiveNest-Releases/releases/latest" target="_blank" rel="noreferrer">下载 Windows 安装版</a>
  </section>}</div>;
}
