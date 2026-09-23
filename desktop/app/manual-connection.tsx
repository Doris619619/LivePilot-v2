/** 手动候选输错密码或端口时，在同一候选上修正，不创建重复身份。 */
"use client";
import { useState } from "react";
import type { DesktopAction, PublicInstance } from "../../src/shared/desktop";
/** 密码不预填、不写浏览器缓存；父页面只传入尚未提交的候选实例。 */
export default function ManualConnection({ instances, disabled, act }: { instances: PublicInstance[]; disabled: boolean; act: (action: DesktopAction, input: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = useState(false); const [id, setId] = useState(instances[0]?.id || ""); const [port, setPort] = useState(String(instances[0]?.port || 4455)); const [password, setPassword] = useState("");
  return <div className="desktop-form"><button disabled={disabled} onClick={() => setOpen(!open)}>修正手动 OBS 连接</button>{open && <><label>OBS<select value={id} onChange={e => { setId(e.target.value); setPort(String(instances.find(i => i.id === e.target.value)?.port || 4455)); setPassword(""); }}>{instances.map(i => <option value={i.id} key={i.id}>{i.name}</option>)}</select></label><label>端口<input type="number" name="port" min={1024} max={65535} aria-invalid={!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535} value={port} onChange={e => setPort(e.target.value)} /></label>{(!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535)&&<p role="alert">端口请输入 1024–65535 的整数。</p>}<label>WebSocket 密码<input name="password" type="password" value={password} onChange={e => setPassword(e.target.value)} /></label><button disabled={disabled || !password || !Number.isInteger(Number(port)) || Number(port)<1024 || Number(port)>65535} onClick={() => void act("repair", { id, port: Number(port), password }).then(ok => {if(ok)setPassword("");})}>保存并检查</button></>}</div>;
}
