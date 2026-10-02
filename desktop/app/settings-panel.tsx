/** 设置沿用工作台的横向设置行、细分隔线与开关；操作固定在右侧。 */
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
import ProblemCard from "../../src/app/components/problem-card";
import UpdateAction from "./update-action";
export default function SettingsPanel({ state, busy, act }: { state: DesktopState; busy: boolean; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean> }) {
  const update = state.update;

  return <div className="desktop-settings">
    <section className="settings-row" aria-labelledby="settings-startup"><div className="settings-value"><h2 id="settings-startup">登录 Windows 后启动</h2></div><button className={"switch-btn " + (state.autoStart ? "active" : "")} role="switch" aria-checked={state.autoStart} aria-labelledby="settings-startup" disabled={busy} onClick={() => void act("autostart", { enabled: !state.autoStart })}><span className="switch-track" aria-hidden="true"><span /></span><span aria-hidden="true">{state.autoStart ? "开启" : "关闭"}</span></button></section>
    <section className="settings-row" aria-labelledby="settings-data"><div className="settings-value"><h2 id="settings-data">LiveNest 数据位置</h2><p className="settings-path">{state.dataRoot || "尚未选择"}</p>{state.dataNotice && <p role="status">{state.dataNotice}</p>}</div><div className="settings-actions"><button disabled={busy || !state.dataRoot} onClick={() => void act("open-data")}>打开文件夹</button><button disabled={busy || !state.dataRoot} onClick={() => void act("open-publishing")}>打开发布目录</button><button disabled={busy} onClick={() => void act("directory")}>{state.dataRoot ? "更改位置" : "选择位置"}</button></div></section>
    {state.paired && <section className="settings-row" aria-labelledby="settings-binding"><div className="settings-value"><h2 id="settings-binding">设备绑定</h2><p>删除后网页和本机均解除绑定。OBS 和素材保留，需要使用新配对码重新连接。</p></div><button disabled={busy} onClick={()=>{if(window.confirm("删除这台电脑的设备绑定？网页将无法控制本机，OBS 和素材保留。重新连接需要新配对码。"))void act("unpair",{confirmed:true});}}>删除设备绑定</button></section>}
    <section className="settings-row" aria-labelledby="settings-update"><div className="settings-value"><h2 id="settings-update">软件更新</h2><div className="settings-version"><span>LiveNest {state.version}</span><span role="status" className={"setup-state " + (update.status === "error" ? "error" : update.status === "downloaded" || update.message === "已是最新版本" ? "ready" : "")}>{update.message || "尚未检查更新"}</span></div></div><div className="settings-actions"><UpdateAction update={update} busy={busy} act={act} /></div></section>
    {update.problem && <ProblemCard problem={update.problem} objectName="软件更新" />}
  </div>;
}
