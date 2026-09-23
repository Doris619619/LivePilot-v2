/** 设置沿用工作台的横向设置行、细分隔线与开关；操作固定在右侧。 */
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
import UpdateAction from "./update-action";
export default function SettingsPanel({ state, busy, act }: { state: DesktopState; busy: boolean; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<void> }) {
  const update = state.update;

  return <div className="desktop-settings">
    <section className="settings-row" aria-labelledby="settings-startup"><div className="settings-value"><h2 id="settings-startup">登录 Windows 后启动</h2></div><button className={"switch-btn " + (state.autoStart ? "active" : "")} role="switch" aria-checked={state.autoStart} aria-labelledby="settings-startup" disabled={busy} onClick={() => void act("autostart", { enabled: !state.autoStart })}><span className="switch-track" aria-hidden="true"><span /></span><span aria-hidden="true">{state.autoStart ? "开启" : "关闭"}</span></button></section>
    <section className="settings-row" aria-labelledby="settings-data"><div className="settings-value"><h2 id="settings-data">数据位置</h2><p className="settings-path">{state.dataRoot}</p><p>新安装默认优先使用 D 盘。安装位置与数据位置独立。</p>{state.dataNotice && <p role="status">{state.dataNotice}</p>}</div><div className="settings-actions"><button disabled={busy} onClick={() => void act("open-data")}>打开文件夹</button><button disabled={busy} onClick={() => void act("directory")}>{state.instances.length ? "更改数据位置" : "选择文件夹"}</button></div></section>
    <section className="settings-row" aria-labelledby="settings-update"><div className="settings-value"><h2 id="settings-update">软件更新</h2><div className="settings-version"><span>LiveNest {state.version}</span><span role="status" className={"setup-state " + (update.status === "error" ? "error" : update.status === "downloaded" || update.message === "已是最新版本" ? "ready" : "")}>{update.message || "尚未检查更新"}</span></div></div><div className="settings-actions"><UpdateAction update={update} busy={busy} act={act} /></div></section>
  </div>;
}
