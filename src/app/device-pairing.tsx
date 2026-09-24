/** 网页添加电脑：一次性邀请只保存在当前页面，不写本地缓存或 URL。 */
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "./client-request";
import type { AgentDescriptor } from "@/shared/remote";
/** 成员创建或恢复邀请；已移除电脑沿用原身份，不能被另一台电脑接管。 */
export default function DevicePairing({ agents }: { agents: AgentDescriptor[] }) {
  const [loadError,setLoadError]=useState("");const [listReady,setListReady]=useState(false);const [loadKey,setLoadKey]=useState(0);
  const [customers,setCustomers]=useState<string[]>();const [owner,setOwner]=useState("");
  useEffect(()=>{let active=true;void api<{user:{role:string}}>("/api/session").then(async s=>{if(s.user.role==="admin"){const d=await api<{customers:{username:string}[]}>("/api/admin/overview");if(active)setCustomers(d.customers.map(c=>c.username));}if(active){setListReady(true);setLoadError("");}}).catch(()=>{if(active){setListReady(false);setLoadError("客户与设备归属暂不可读取，请重新读取后生成配对码。");}});return()=>{active=false;};},[loadKey]);
  const [open, setOpen] = useState(false); const [name, setName] = useState("");
  const [invitation, setInvitation] = useState(""); const [agentId, setAgentId] = useState<string>();
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const submitting = useRef(false);
  const invitationRecord = agents.find(a => a.id === agentId);
  const selected = agents.find(a => a.id === (invitationRecord?.pairedTo || agentId)); const paired = !!selected?.paired && !selected.revoked;
  const recoverable = agents.filter(a => !a.pairedTo && !a.revoked && !a.paired);
  /** 重试复用未使用邀请的设备 ID，已配对时服务器拒绝覆盖。 */
  async function create() {
    if (submitting.current || !listReady) return; submitting.current = true; setBusy(true); setMessage("");
    try { const result = await api<{ agentId: string; invitation: string }>("/api/devices/pairing", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ name, ...(customers ? {owner: selected?.owner || owner} : {}), agentId: invitationRecord?.pairedTo ? undefined : agentId }) }); setAgentId(result.agentId); setInvitation(result.invitation); }
    catch (e) { setMessage((e as Error).message); } finally { submitting.current = false; setBusy(false); }
  }
  /** 完成上一台后才清空表单，失败或收起面板不另建电脑。 */
  function toggle() { if (!open && paired) { setAgentId(undefined); setName(""); setInvitation(""); setMessage(""); } setOpen(!open); }
  return <div className="device-pairing"><button onClick={toggle} aria-expanded={open}>添加直播电脑</button>{open && <section className="pairing-panel" aria-label="添加直播电脑">{loadError && <p role="alert">{loadError}<button onClick={()=>setLoadKey(k=>k+1)}>重新读取客户</button></p>}
    {paired ? <><p role="status">{selected.online ? "连接成功" : "配对成功，等待电脑上线"}：{selected.name}</p><a href={"#device-" + selected.id} onClick={() => setOpen(false)}>查看电脑</a></> : <>
      {!invitation && <>{customers && <label className="field-group">所属客户<select value={selected?.owner || owner} disabled={!!selected?.owner} onChange={e=>setOwner(e.target.value)}><option value="">选择客户</option>{customers.map(c=><option key={c}>{c}</option>)}</select></label>}
        <label className="field-group">电脑名称<input disabled={!listReady || busy || !!agentId} value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="给这台电脑起个名字" /></label>
        {!!recoverable.length && <details><summary>继续配对尚未连接的电脑</summary><label className="field-group">选择原电脑<select disabled={!listReady || busy} value={agentId || ""} onChange={e => { const id = e.target.value; setAgentId(id || undefined); setName(agents.find(a => a.id === id)?.name || ""); setMessage(""); }}><option value="">添加新电脑</option>{recoverable.map(a => <option key={a.id} value={a.id}>{a.name} · {a.id.slice(-6)}{a.revoked ? "（已移除）" : "（待配对）"}</option>)}</select></label></details>}

      </>}
      {invitation ? <>
        <p>将配对码粘贴到这台电脑的 LiveNest，点击“连接”。</p>
        <button className="btn-primary" onClick={() => void navigator.clipboard.writeText(invitation).then(() => setMessage("已复制，请到 LiveNest 粘贴并连接。"), () => setMessage("复制失败，请展开下方配对码，选中后按 Ctrl+C。"))}>复制配对码</button>
        <details><summary>查看配对码</summary><label className="field-group">配对码（10 分钟内有效）<textarea readOnly value={invitation} rows={3} /></label><button disabled={!listReady || busy} onClick={() => void create()}>{busy ? "正在生成…" : "重新生成配对码"}</button></details>
      </> : <button className="btn-primary" disabled={!listReady || busy || !name.trim()} onClick={() => void create()}>{busy ? "正在生成…" : "生成配对码"}</button>}
      {message && <p role="status">{message}</p>}<Link href="/download">下载 Windows 客户端</Link>
    </>}
  </section>}</div>;
}
