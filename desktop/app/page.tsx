/** 本机配置工作区，复用网站外观；所有系统操作由受限桌面桥接执行。 */
"use client";
import { useEffect, useState } from "react";
import { activityStep, type DesktopActivity, type DesktopAction, type DesktopBridge, type DesktopState } from "../../src/shared/desktop";
import { DeviceIcon, VideoIcon, RefreshIcon } from "../../src/app/components/icons";
import Help from "./help";
import Login from "./login";
import UpdateEntry from "./update-entry";
import SettingsPanel from "./settings-panel";
import SetupFeedback from "./setup-feedback";
import ManualConnection from "./manual-connection";
declare global { interface Window { liveNest?: DesktopBridge } }
const pages = ["设备配置", "本机 OBS", "帮助", "设置"] as const;
/** 六步进度来自真实检查与新鲜 Agent 状态，不使用模拟百分比。 */
export default function Page() { return <Login>{logout => <Desktop logout={logout} />}</Login>; }
/** 登录后的配置界面持续读取后台状态。 */
function Desktop({ logout }: { logout: () => Promise<void> }) {
  const [page, setPage] = useState<(typeof pages)[number]>("设备配置"); const [state, setState] = useState<DesktopState>();
  const [now, setNow] = useState(0);
  const [activeAction, setActiveAction] = useState<DesktopAction>(); const [failedStep, setFailedStep] = useState(0);
  const [error, setError] = useState(""); const [pending, setPending] = useState(false); const [invitation, setInvitation] = useState("");
  const [attach, setAttach] = useState(false); const [port, setPort] = useState("4455"); const [password, setPassword] = useState("");
  useEffect(() => {
    let disposed = false; let reading = false;
    /** 后台状态轮询不清空用户输入，不把旧快照当作新鲜状态。 */
    async function load() { if (reading) return; reading = true; try { if (!window.liveNest) throw new Error("请从安装后的 LiveNest 打开此页面。"); const next = await window.liveNest.state(); if (!disposed) { setState(next); setNow(Date.now()); } } catch (e) { if (!disposed) setError((e as Error).message); } finally { reading = false; } }
    void load(); const timer = setInterval(() => void load(), 2000); return () => { disposed = true; clearInterval(timer); };
  }, []);
  /** 写操作去重，失败保留表单，成功后采用宿主最新快照。 */
  async function act(action: DesktopAction, input?: Record<string, unknown>) {
    if (pending) return; setPending(true); setActiveAction(action); setFailedStep(0); setError("");
    if (action !== "web") setState(previous => previous && ({ ...previous, activity: { action, step: activityStep(action), status: "running", stage: "正在检查操作条件", startedAt: now } }));
    try { if (!window.liveNest) throw new Error("桌面连接不可用。"); setState(await window.liveNest.act(action, input)); if (action === "pair") setInvitation(""); if (action === "attach") { setPassword(""); setAttach(false); } }
    catch (e) { setFailedStep(activityStep(action)); setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setPending(false); setActiveAction(undefined); }
  }
  const reportedActivity: DesktopActivity | undefined = failedStep && error ? { action: state?.activity?.action || "prepare", step: failedStep, status: "failed", stage: state?.activity?.stage || "操作未完成", startedAt: state?.activity?.startedAt || now, message: error } : state?.activity;
  // 自动重连的真实心跳可以结算连接失败；仍有维护待恢复时不能隐藏错误。
  const connectionRecovered = !!state?.online && !state.maintenance && reportedActivity?.step === 3 && reportedActivity.status === "failed";
  const activity = connectionRecovered ? undefined : reportedActivity;
  const visibleError = connectionRecovered ? "" : error || state?.message;
  const pairingExpired = !state?.online && state?.connectionError === "AGENT_AUTH";
  const inline = !!activity?.step && activity.status !== "complete" && (page === "设备配置" || (page === "本机 OBS" && activity.step === 2));
  const busy = pending || state?.busy; const instances = state?.instances || []; const candidates = state?.candidates || [];
  const fresh = state?.snapshots.filter(s => now - s.observedAt < 20_000) || [];
  const channel = instances.length > 0 && instances.every(i => fresh.some(s => s.instance.id === i.id && s.dashboard.youtube.connected));
  const media = instances.length > 0 && instances.every(i => fresh.some(s => s.instance.id === i.id && s.dashboard.media.videos.length && s.dashboard.media.music.length));
  const computer = !!state?.checks.length && state.checks.filter(c => c.id !== "cloud").every(c => c.status === "ready");
  const obs = instances.length > 0 && instances.every(i => i.initialized);
  const complete = computer && obs && state?.online && channel && media && fresh.length === instances.length && fresh.every(s => s.dashboard.obs.ready && !s.dashboard.configuration.missing.length);
  /** 每个配置区只有标题、状态和必要操作。 */
  function step(n: number, title: string, ready: boolean | undefined, content: React.ReactNode) {
    const checking = (pending && activityStep(activeAction) === n) || (activity?.step === n && activity.status === "running");
    const failed = !checking && ((!connectionRecovered && failedStep === n) || (activity?.step === n && activity.status === "failed") || (n === 1 && state?.checks.some(c => c.id !== "cloud" && ["error", "missing"].includes(c.status))));
    return <section className="setup-row"><span className="step-number">{n}</span><div><div className="setup-title"><h2>{title}</h2><span className={"setup-state " + (failed ? "error" : ready ? "ready" : "")}>{checking ? "检查中" : failed ? "需要处理" : ready ? "已完成" : "待完成"}</span></div><div className="setup-content">{content}{activity?.step === n && feedback()}</div></div></section>;
  }
  /** 错误重试复用现有实例；不再次创建 OBS，保留页面表单。 */
  function feedback() {
    if (!activity) return null;
    return <SetupFeedback activity={activity} now={now} disabled={!!busy} help={() => setPage("帮助")} retry={pairingExpired && activity.step === 3 ? undefined : () => { if (activity.step === 2) void act("prepare"); else void act(activity.step === 1 ? "check" : state?.paired ? "start" : "pair", { invitation }); }} />;
  }
  /** 首次配对和恢复都使用同一个输入框，不暴露设备内部标识。 */
  function pairingForm() {
    return <><label className="field-group">配对码<textarea value={invitation} onChange={e => setInvitation(e.target.value)} placeholder="粘贴网页复制的配对码" /></label><button className="btn-primary" disabled={busy || !obs || !invitation.trim()} onClick={() => void act("pair", { invitation })}>连接</button></>;
  }
  return <><header className="app-header"><div className="header-container"><div className="brand-section"><span aria-hidden="true" style={{ color: "var(--accent-primary)", fontSize: 24 }}>◉</span><span className="brand-name">LiveNest</span><span className="brand-tag">Studio</span></div><div className="desktop-actions desktop-header-actions">{state && <UpdateEntry update={state.update} busy={!!busy} act={act} error={state.activity?.action === "update-install" && state.activity.status === "failed" ? state.activity.message : undefined} />}<button className="btn-ghost" onClick={() => void act("web")}>打开网页工作台 ↗</button><span>Do</span><button className="btn-ghost" onClick={() => void logout()}>退出登录</button></div></div></header>
    <div className="workspace-shell"><aside className="workspace-sidebar"><nav aria-label="桌面导航">{pages.map(p => <button key={p} className={"sidebar-link desktop-nav " + (p === page ? "is-active" : "")} onClick={() => setPage(p)}>{p === "本机 OBS" ? <VideoIcon /> : <DeviceIcon />}<span>{p}</span></button>)}</nav><div className="desktop-status"><span className={"device-state " + (state?.online ? "online" : "")}>{state?.online ? "设备在线" : pairingExpired ? "配对已失效" : state?.agentRunning ? visibleError ? "等待重连" : "正在连接" : "尚未连接"}</span></div></aside>
    <main className="main-wrapper"><div className="workspace-heading"><h1>{page}</h1>{page === "设备配置" && <button disabled={busy} onClick={() => void act("check")}><RefreshIcon />重新检查</button>}</div>
    {state?.maintenance && <div className="banner" role="status">设备维护尚未确认结束，原配置已保留。<button disabled={busy} onClick={() => void act("start")}>重新连接并恢复</button></div>}
    {!!candidates.length && <section className="desktop-form"><h2>待配置 OBS</h2><p>验证成功后才加入设备；撤销保留本机文件和配置。</p>{candidates.map(i => <div key={i.id}><strong>{i.name}</strong><span>　端口 {i.port}　</span><button disabled={busy} onClick={() => void act("prepare", { id: i.id })}>重试配置</button>{i.managed && <button disabled={busy} onClick={() => void act("repair-managed", { id: i.id })}>修复连接（先关闭 OBS）</button>}<button disabled={busy} onClick={() => void act("discard", { id: i.id })}>撤销新增</button></div>)}{!!candidates.filter(i => !i.managed).length && <ManualConnection instances={candidates.filter(i => !i.managed)} disabled={!!busy} act={act} />}</section>}
    {!inline && visibleError && <div className="banner error" role="alert">{visibleError}<button onClick={() => setPage("帮助")}>查看帮助</button></div>}
    {!state && <p role="status">正在读取本机配置…</p>}
    {state && page === "设备配置" && <div className="setup-list">
      {step(1, "检查电脑", computer, <><div className="check-list">{state.checks.map(c => <div key={c.id}><div className="check-row"><span>{c.label}</span><span className={"setup-state " + c.status}>{c.status === "ready" ? "正常" : c.status === "pending" ? "待检查" : "需要处理"}</span></div>{c.message && <p className="check-message">{c.message}</p>}</div>)}</div><button disabled={busy} onClick={() => void act("check")}>检查电脑</button></>)}
      {step(2, "准备 OBS", obs, <><p>无需预装 OBS。点击“自动准备 OBS”会使用安装包内置的独立便携版。</p><div>{instances.length ? instances.map(i => <div key={i.id}>{i.name}　{i.initialized ? "已配置" : "尚未完成"}</div>) : "尚未配置 OBS"}</div><div className="desktop-actions"><button className="btn-primary" disabled={busy} onClick={() => void act("prepare")}>{activity?.step === 2 && activity.status === "running" ? "正在准备 OBS…" : "自动准备 OBS"}</button><button className="btn-ghost" onClick={() => setPage("本机 OBS")}>管理 OBS</button></div></>)}
      {step(3, "连接网页", state.online, <>{state.online ? <p>本机已连接网页工作台</p> : !state.paired || pairingExpired ? <><button onClick={() => void act("web")}>{pairingExpired ? "打开网页，恢复这台电脑 ↗" : "打开网页，添加直播电脑 ↗"}</button>{pairingForm()}</> : <><p>正在等待连接，原配对已保留。</p><button disabled={busy} onClick={() => void act("start")}>重新连接</button><details><summary>粘贴新的配对码</summary>{pairingForm()}</details></>}</>)}
      {step(4, "连接频道", channel, <><div>{fresh.map(s => <div key={s.instance.id}>{s.instance.name}　{s.dashboard.youtube.connected ? s.dashboard.youtube.channel : "尚未授权"}</div>)}</div><button disabled={!state.paired} onClick={() => void act("web")}>前往网页授权 ↗</button></>)}
      {step(5, "准备素材", media, <><div>{fresh.map(s => <div key={s.instance.id}>{s.instance.name}　视频 {s.dashboard.media.videos.length} · 音乐 {s.dashboard.media.music.length}</div>)}</div><button disabled={!state.paired} onClick={() => void act("web")}>前往网页选择素材 ↗</button></>)}
      {step(6, "完成检查", complete, <><p>{complete ? "配置就绪，可以前往网页工作台。" : "完成以上步骤后，重新检查本机与网页连接。"}</p><button className="btn-primary" disabled={!complete} onClick={() => void act("web")}>打开网页工作台 ↗</button></>)}
    </div>}
    {state && page === "本机 OBS" && <>{activity?.step === 2 && feedback()}<div className="desktop-actions"><button className="btn-primary" disabled={busy} onClick={() => void act("add")}>增加 OBS</button><button disabled={busy} onClick={() => setAttach(!attach)}>接入已有 OBS</button></div>{attach && <div className="desktop-form"><label>端口<input value={port} onChange={e => setPort(e.target.value)} /></label><label>WebSocket 密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} /></label><button disabled={busy || !password} onClick={() => void act("attach", { port: Number(port), password })}>选择 obs64.exe 并检查</button><button className="btn-ghost" onClick={() => setPage("帮助")}>查看 OBS 配置图解</button></div>}{instances.map(i => <section className="desktop-instance" key={i.id}><div className="setup-title"><h2>{i.name}</h2><span className={"setup-state " + (i.initialized ? "ready" : "")}>{i.initialized ? "已配置" : "待配置"}</span></div><p className="desktop-path">{i.exe}</p><div className="desktop-actions"><span>端口 {i.port}</span>{i.managed && <button disabled={busy} onClick={() => void act("repair-managed", { id: i.id })}>修复连接（先关闭 OBS）</button>}<button disabled={busy} onClick={() => void act("prepare", { id: i.id })}>启动并检查</button><input aria-label={i.name + "名称"} defaultValue={i.name} maxLength={80} onBlur={e => { if (e.target.value.trim() && e.target.value !== i.name) void act("rename", { id: i.id, name: e.target.value }); }} /></div></section>)}</>}
    {page === "帮助" && <Help />}
    {state && page === "设置" && <SettingsPanel state={state} busy={!!busy} act={act} />}
    </main></div></>;
}
