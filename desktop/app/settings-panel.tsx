/** 设置沿用工作台的横向设置行、细分隔线与开关；操作固定在右侧。 */
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
export default function SettingsPanel({ state, busy, act }: { state: DesktopState; busy: boolean; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<void> }) {
  const update = state.update;
  const updating = ["checking", "downloading", "installing"].includes(update.status);
  const action: DesktopAction = update.status === "available" ? "update-download" : update.status === "downloaded" ? "update-install" : "update-check";
  const label = update.status === "available" ? "下载更新" : update.status === "downloaded" ? "重启更新" : update.status === "checking" ? "正在检查…" : update.status === "installing" ? "正在安装…" : update.status === "downloading" ? "正在下载 " + Math.round(update.percent || 0) + "%" : "检查更新";
  const canChoose = !state.instances.length && !state.agentId;
  return <div className="desktop-settings">
    <section className="settings-row" aria-labelledby="settings-startup"><div className="settings-value"><h2 id="settings-startup">登录 Windows 后启动</h2></div><button className={"switch-btn " + (state.autoStart ? "active" : "")} role="switch" aria-checked={state.autoStart} aria-labelledby="settings-startup" disabled={busy} onClick={() => void act("autostart", { enabled: !state.autoStart })}><span className="switch-track" aria-hidden="true"><span /></span><span aria-hidden="true">{state.autoStart ? "开启" : "关闭"}</span></button></section>
    <section className="settings-row" aria-labelledby="settings-data"><div className="settings-value"><h2 id="settings-data">数据位置</h2><p className="settings-path">{state.dataRoot}</p></div><div className="settings-actions"><button disabled={busy} onClick={() => void act("open-data")}>打开文件夹</button>{canChoose && <button disabled={busy} onClick={() => void act("directory")}>选择文件夹</button>}</div></section>
    <section className="settings-row" aria-labelledby="settings-update"><div className="settings-value"><h2 id="settings-update">软件更新</h2><div className="settings-version"><span>LiveNest {state.version}</span><span role="status" className={"setup-state " + (update.status === "error" ? "error" : update.status === "downloaded" || update.message === "已是最新版本" ? "ready" : "")}>{update.message || "尚未检查更新"}</span></div></div><div className="settings-actions"><button className={action !== "update-check" ? "btn-primary" : ""} disabled={busy || updating} onClick={() => void act(action)}>{label}</button></div></section>
  </div>;
}
