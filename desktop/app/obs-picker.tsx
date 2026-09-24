/** 默认创建干净独立 OBS；扫描、复制与手动接入只在高级区域展示。 */
import { useState } from "react";
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
/** 新增只需配置新实例，电脑身份与原频道继续复用。 */
export default function ObsPicker({state,busy,act}:{state:DesktopState;busy:boolean;act:(a:DesktopAction,i?:Record<string,unknown>)=>Promise<boolean>}){
 const [name,setName]=useState("OBS "+(state.instances.length+1));const scan=state.scan;
 const [port,setPort]=useState("4455"); const [password,setPassword]=useState("");
 const firstPending=!state.instances.length && [...(state.candidates||[]),...(state.archivedCandidates||[])].some(i=>i.id==="main");
 const unavailable=busy || state.dataLocationReady===false || firstPending;
 const blocked=state.snapshots.filter(s=>s.dashboard.obs.streaming!==false||s.dashboard.busy||["starting","stopping"].includes(s.dashboard.state.phase));
 return <section className="desktop-form obs-add"><h3>{state.instances.length ? "添加另一个 OBS" : "添加第一个 OBS"}</h3><p>自动创建独立 OBS，并准备连接和视频、音乐场景。每个 OBS 使用独立目录；随后分别选择频道和素材。</p>
 <button className="btn-primary" disabled={unavailable} onClick={()=>void act("add")}>{state.instances.length===1?"+ 添加第二个 OBS":state.instances.length?"+ 添加 OBS":"准备第一个 OBS"}</button>
 <p>{state.paired?"这台电脑已配对，添加 OBS 无需重新配对。":"一台电脑只需配对一次，所有 OBS 都会显示在这台电脑下。"}</p>
 {firstPending&&<p>请在待配置或已撤销区域继续准备第一个 OBS。</p>}
 {!!blocked.length&&<p role="status">添加前需确认空闲：{blocked.map(s=>s.instance.name).join("、")}。请先结束直播、录制、上传与授权。</p>}
 <details><summary>高级选项 / 接入已有 OBS</summary>
 <label className="field-group">新 OBS 名称<input value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
 <div className="desktop-actions"><button disabled={busy||scan?.running} onClick={()=>void act("scan")}>扫描电脑</button><button disabled={unavailable||!name.trim()} onClick={()=>void act("import-obs",{name})}>浏览选择 obs64.exe</button></div>
 <p>选中的已有 OBS 将复制为独立实例，自动准备标准视频和音乐场景，原 OBS 保留。</p>
 {scan&&<><div role="status">{scan.running?"正在扫描："+scan.current:scan.canceled?"扫描已取消，以下结果不完整。":scan.visited?"扫描结束":"尚未扫描"}{scan.error&&" · "+scan.error}</div>{scan.running?<button onClick={()=>void act("scan-cancel")}>取消扫描</button>:<button disabled={busy} onClick={()=>void act("scan",{deep:true})}>完整扫描所有本地固定磁盘</button>}<p>已扫描盘符：{scan.completedDrives.join("、")||"—"} · {scan.deep?"完整扫描":"常见位置快速扫描"}</p>{!!scan.inaccessible.length&&<details><summary>有 {scan.inaccessible.length} 个位置无法访问或已跳过，结果可能不完整</summary>{scan.inaccessible.map((f,i)=><p className="desktop-path" key={i}>{f}</p>)}</details>}
 {scan.results.map(c=><div className="obs-candidate" key={c.exe}><p className="desktop-path">{c.exe}</p><p>版本 {c.version} · {c.processKnown===false?"运行状态未知":c.running?"运行中，复制前请关闭":"未运行"}{c.attached?" · 已接入":""}</p>{c.error?<p role="status">{c.error}</p>:<button disabled={busy||c.running||!name.trim()} onClick={()=>void act("import-obs",{exe:c.exe,name})}>选择并复制为 {name}</button>}</div>)}</>}
 <details><summary>直接连接专用便携 OBS（不复制）</summary><label className="field-group">WebSocket 端口<input type="number" min={1024} max={65535} value={port} onChange={e=>setPort(e.target.value)}/></label><label className="field-group">WebSocket 密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button disabled={unavailable||!password||!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535} onClick={()=>void act("attach",{port:Number(port),password}).then(ok=>{if(ok)setPassword("");})}>选择 obs64.exe 并检查</button></details>
 </details></section>;
}
