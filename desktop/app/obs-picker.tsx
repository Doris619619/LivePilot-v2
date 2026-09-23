/** OBS 来源选择：扫描、手选与内置版共用命名和实例引导。 */
import { useState } from "react";
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
/** 新增只需配置新实例，电脑身份与原频道继续复用。 */
export default function ObsPicker({state,busy,act}:{state:DesktopState;busy:boolean;act:(a:DesktopAction,i?:Record<string,unknown>)=>Promise<void>}){
 const [name,setName]=useState("OBS "+(state.instances.length+1));const scan=state.scan;
 const blocked=state.snapshots.filter(s=>s.dashboard.obs.streaming!==false||s.dashboard.busy||["starting","stopping"].includes(s.dashboard.state.phase));
 return <section className="desktop-form"><h2>{state.instances.length?"添加下一个 OBS":"选择 OBS 来源"}</h2><p>{state.paired?"这台电脑已配对，无需重新配对。":"先选择 OBS，准备完成后再连接网页。"}每个实例使用独立端口、频道和素材。</p>{!!blocked.length&&<p role="status">添加前需确认空闲：{blocked.map(s=>s.instance.name).join("、")}。请先结束直播、上传与授权。</p>}
 <label className="field-group">新 OBS 名称<input value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
 <div className="desktop-actions"><button disabled={busy||scan?.running} onClick={()=>void act("scan")}>扫描电脑</button><button disabled={busy||!name.trim()} onClick={()=>void act("import-obs",{name})}>浏览选择 obs64.exe</button><button className="btn-primary" disabled={busy||!name.trim()} onClick={()=>void act("add",{name})}>使用内置 OBS</button></div>
 <p>选中的已有 OBS 将复制为独立实例，自动准备标准视频和音乐场景，原 OBS 保留。</p>
 {scan&&<><div role="status">{scan.running?"正在扫描："+scan.current:scan.canceled?"扫描已取消，以下结果不完整。":scan.visited?"扫描结束":"尚未扫描"}{scan.error&&" · "+scan.error}</div>{scan.running?<button onClick={()=>void act("scan-cancel")}>取消扫描</button>:<button disabled={busy} onClick={()=>void act("scan",{deep:true})}>完整扫描所有本地固定磁盘</button>}<p>已扫描盘符：{scan.completedDrives.join("、")||"—"} · {scan.deep?"完整扫描":"常见位置快速扫描"}</p>{!!scan.inaccessible.length&&<details><summary>有 {scan.inaccessible.length} 个位置无法访问或已跳过，结果可能不完整</summary>{scan.inaccessible.map((f,i)=><p className="desktop-path" key={i}>{f}</p>)}</details>}
 {scan.results.map(c=><div className="obs-candidate" key={c.exe}><p className="desktop-path">{c.exe}</p><p>版本 {c.version} · {c.running?"运行中，复制前请关闭":"未运行"}{c.attached?" · 已接入":""}</p>{c.error?<p role="status">{c.error}</p>:<button disabled={busy||c.running||!name.trim()} onClick={()=>void act("import-obs",{exe:c.exe,name})}>选择并复制为 {name}</button>}</div>)}</>}
 </section>;
}
