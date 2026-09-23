/** 本机配置工作区，复用网站外观；所有系统操作由受限桌面桥接执行。 */
"use client";
import { useEffect, useState } from "react";
import { activityStep, type DesktopActivity, type DesktopAction, type DesktopBridge, type DesktopState } from "../../src/shared/desktop";
import { DeviceIcon, VideoIcon, RefreshIcon } from "../../src/app/components/icons";
import ProblemCard from "../../src/app/components/problem-card";
import { makeProblem, type Problem } from "../../src/shared/problems";
import Help from "./help";
import Login from "./login";
import UpdateEntry from "./update-entry";
import SettingsPanel from "./settings-panel";
import SetupFeedback from "./setup-feedback";
import ObsPicker from "./obs-picker";
import ManualConnection from "./manual-connection";
import { UpdateProvider, useLocalUpdates } from "./local-updates";
declare global { interface Window { liveNest?: DesktopBridge } }
const pages = ["设备配置", "本机 OBS", "帮助", "设置"] as const;
/** 六步进度来自真实检查与新鲜 Agent 状态，不使用模拟百分比。 */
export default function Page() { return <UpdateProvider><Login>{(logout, username) => <Desktop logout={logout} username={username} />}</Login></UpdateProvider>; }
/** 登录后的配置界面持续读取后台状态。 */
function Desktop({ logout, username }: { logout: () => Promise<void>; username: string }) {
  const localUpdates = useLocalUpdates();
  const [page, setPage] = useState<(typeof pages)[number]>("设备配置"); const [state, setState] = useState<DesktopState>();
  const [now, setNow] = useState(0); const [lastRead, setLastRead] = useState(0); const [readError,setReadError] = useState(""); const [problem,setProblem] = useState<Problem>(); const [helpTopic,setHelpTopic] = useState("obs");
  const [failedActivity,setFailedActivity] = useState<DesktopActivity>();
  const [activeAction, setActiveAction] = useState<DesktopAction>(); const [failedStep, setFailedStep] = useState(0);
  const [error, setError] = useState(""); const [pending, setPending] = useState(false); const [invitation, setInvitation] = useState("");

  useEffect(() => {
    let disposed = false; let reading = false;
    /** 后台状态轮询不清空用户输入，不把旧快照当作新鲜状态。 */
    async function load() { if (reading) return; reading = true; try { if (!window.liveNest) throw new Error("请从安装后的 LiveNest 打开此页面。"); const next = await window.liveNest.state(); if (!disposed) { setState(next); setLastRead(Date.now()); setReadError(""); } } catch { if (!disposed) setReadError("本机状态暂不可读取，请重新检查；已有直播状态需要核对。"); } finally { reading = false; } }
    void load(); const clock=setInterval(()=>setNow(Date.now()),1000); const timer = setInterval(() => void load(), 2000); return () => { disposed = true; clearInterval(timer);clearInterval(clock); };
  }, []);
  /** 写操作去重，失败保留表单，成功后采用宿主最新快照。 */
  async function act(action: DesktopAction, input?: Record<string, unknown>) {
    if (["update-check", "update-download", "update-install", "update-apply"].includes(action)) return localUpdates.act(action);
    if (pending) return false; setProblem(undefined); setFailedActivity(undefined); setPending(true); setActiveAction(action); setFailedStep(0); setError("");
    if (action !== "web") setState(previous => previous && ({ ...previous, activity: { instanceId: typeof input?.id === "string" ? input.id : undefined, action, step: activityStep(action), status: "running", stage: "正在检查操作条件", startedAt: now } }));
    try { if (!window.liveNest) throw new Error("桌面连接不可用。"); const result=await window.liveNest.act(action,input); if(!result.ok){const message=result.problem.message+(result.fields?" · "+Object.entries(result.fields).map(([key,value])=>({port:"端口",password:"密码",name:"名称"}[key]||key)+"："+value).join("；"):"");const failure={...result.problem,message};setFailedActivity({action,instanceId:failure.target.instanceId || (typeof input?.id==="string"?input.id:undefined),step:activityStep(action),status:"failed",stage:failure.stage,attemptId:failure.attemptId,startedAt:failure.observedAt,problem:failure,message});setProblem(failure);setError(message);setFailedStep(activityStep(action));const field=Object.keys(result.fields||{})[0];if(field)document.querySelector<HTMLInputElement>('[name="'+CSS.escape(field)+'"]')?.focus();return false;} setState(result.state);if(!result.cancelled && action==="pair")setInvitation("");return !result.cancelled; }
    catch { const failure=makeProblem("DESKTOP_IPC","本机操作结果未确认，请先重新读取原对象状态。",{target:{instanceId:typeof input?.id==="string"?input.id:undefined}});setProblem(failure);setFailedStep(activityStep(action));setError(failure.message);setFailedActivity({action,instanceId:failure.target.instanceId,step:activityStep(action),status:"failed",stage:failure.stage,startedAt:failure.observedAt,problem:failure,message:failure.message});return false; }
    finally { setPending(false); setActiveAction(undefined); }
  }
  const reportedActivity: DesktopActivity | undefined = failedActivity || state?.activity;
  // 自动重连的真实心跳可以结算连接失败；仍有维护待恢复时不能隐藏错误。
  const online = !!state?.online && now-lastRead<20_000 && !readError;
  const connectionRecovered = online && !state.maintenance && reportedActivity?.step === 3 && reportedActivity.status === "failed";
  const activity = connectionRecovered ? undefined : reportedActivity;
  const visibleError = connectionRecovered ? "" : error || (state?.activity?.action.startsWith("update-") ? "" : state?.message);
  const pairingExpired = !state?.online && state?.connectionError === "AGENT_AUTH";
  const inline = !!activity?.step && activity.status !== "complete" && (page === "设备配置" || (page === "本机 OBS" && activity.step === 2));
  const busy = pending || state?.busy; const instances = state?.instances || []; const candidates = state?.candidates || [];
  const fresh = !readError && now-lastRead<20_000 ? state?.snapshots.filter(s => now - s.observedAt < 20_000) || [] : [];
  const channel = instances.length > 0 && instances.every(i => fresh.some(s => s.instance.id === i.id && s.dashboard.youtube.connected && !s.dashboard.youtube.error));
  const media = instances.length > 0 && instances.every(i => fresh.some(s => s.instance.id === i.id && !s.dashboard.media.error && s.dashboard.media.videos.length && s.dashboard.media.music.length));
  const computer = !!state?.checks.length && state.checks.filter(c => c.id !== "cloud" && !c.instanceId).every(c => c.status === "ready");
  const obsConfigured = instances.length>0 && instances.every(i=>i.initialized);
  const obs = obsConfigured && instances.every(i=>fresh.some(s=>s.instance.id===i.id&&s.dashboard.obs.ready) || state?.checks.some(c=>c.id==="network-"+i.id&&c.status==="ready"));
  const complete = computer && state?.checks.filter(c=>c.instanceId).every(c=>c.status === "ready") && obs && online && channel && media && fresh.length === instances.length && fresh.every(s => s.dashboard.obs.ready && !s.dashboard.configuration.missing.length);
  /** 每个配置区只有标题、状态和必要操作。 */
  function step(n: number, title: string, ready: boolean | undefined, content: React.ReactNode) {
    const checking = (pending && activityStep(activeAction) === n) || (activity?.step === n && activity.status === "running");
    const failed = !checking && ((!connectionRecovered && failedStep === n) || (activity?.step === n && activity.status === "failed") || (n === 1 && state?.checks.some(c => c.id !== "cloud" && !c.instanceId && ["error", "missing"].includes(c.status))));
    return <section className="setup-row"><span className="step-number">{n}</span><div><div className="setup-title"><h2>{title}</h2><span className={"setup-state " + (failed ? "error" : ready ? "ready" : "")}>{checking ? "检查中" : failed ? "需要处理" : ready ? "已完成" : "待完成"}</span></div><div className="setup-content">{content}{activity?.step === n && feedback()}</div></div></section>;
  }
  /** 错误重试复用现有实例；不再次创建 OBS，保留页面表单。 */
  function feedback() {
    if (!activity) return null;
    const inspect = activity.instanceId ? ()=>void act("diagnose-obs",{id:activity.instanceId}) : ()=>void act("check");
    return activity.status === "failed" ? <ProblemCard problem={activity.problem || problem || makeProblem("DESKTOP",activity.message || "此步骤未完成",{target:{instanceId:activity.instanceId},stage:activity.stage,attemptId:activity.attemptId})} objectName={instances.concat(candidates).find(i=>i.id===activity.instanceId)?.name} disabled={!!busy} onRefresh={inspect} onSettings={()=>{setHelpTopic("obs");setPage("帮助");}} onHelp={()=>{setHelpTopic(activity.step===2?"obs":"recovery");setPage("帮助");}} /> : <SetupFeedback activity={activity} now={now} disabled={!!busy} help={()=>setPage("帮助")} />;
  }
  /** 首次配对和恢复都使用同一个输入框，不暴露设备内部标识。 */
  function pairingForm() {
    return <><label className="field-group">配对码<textarea value={invitation} onChange={e => setInvitation(e.target.value)} placeholder="粘贴网页复制的配对码" /></label><button className="btn-primary" disabled={busy || !obsConfigured || !invitation.trim()} onClick={() => void act("pair", { invitation })}>连接</button></>;
  }
  return <><header className="app-header"><div className="header-container"><div className="brand-section"><span aria-hidden="true" style={{ color: "var(--accent-primary)", fontSize: 24 }}>◉</span><span className="brand-name">LiveNest</span><span className="brand-tag">Studio</span></div><div className="desktop-actions desktop-header-actions">{localUpdates.state && <UpdateEntry update={localUpdates.state.update} busy={localUpdates.pending || localUpdates.state.busy} act={localUpdates.act} error={localUpdates.error} />}<button className="btn-ghost" onClick={() => void act("web")}>打开网页工作台 ↗</button><span>{username}</span><button className="btn-ghost" onClick={() => void logout()}>退出登录</button></div></div></header>
    <div className="workspace-shell"><aside className="workspace-sidebar"><nav aria-label="桌面导航">{pages.map(p => <button key={p} className={"sidebar-link desktop-nav " + (p === page ? "is-active" : "")} onClick={() => setPage(p)}>{p === "本机 OBS" ? <VideoIcon /> : <DeviceIcon />}<span>{p}</span></button>)}</nav><div className="desktop-status"><span className={"device-state " + (online ? "online" : "")}>{online ? "设备在线" : pairingExpired ? "配对已失效" : state?.agentRunning ? visibleError ? "等待重连" : "正在连接" : "尚未连接"}</span></div></aside>
    <main className="main-wrapper"><div className="workspace-heading"><h1>{page}</h1>{page === "设备配置" && <button disabled={busy} onClick={() => void act("check")}><RefreshIcon />重新检查</button>}</div>
    {state?.maintenance && <div className="banner" role="status">设备维护尚未确认结束，原配置已保留。<button disabled={busy} onClick={() => void act("start")}>重新连接并恢复</button></div>}
    {!!candidates.length && <section className="desktop-form"><h2>待配置 OBS</h2><p>验证成功后才加入设备；撤销保留本机文件和配置。</p>{candidates.map(i => <div key={i.id}><strong>{i.name}</strong><span>　端口 {i.port}　</span><button disabled={busy} onClick={() => void act("prepare", { id: i.id })}>{i.id==="main"&&!instances.length?"继续准备第一个 OBS":"重试配置"}</button>{i.managed && <button disabled={busy} onClick={() => void act("repair-managed", { id: i.id })}>修复连接（先关闭 OBS）</button>}<button disabled={busy} onClick={() => void act("discard", { id: i.id })}>撤销新增</button></div>)}{!!candidates.filter(i => !i.managed).length && <ManualConnection instances={candidates.filter(i => !i.managed)} disabled={!!busy} act={act} />}</section>}
    {!!state?.archivedCandidates?.length && <section className="desktop-form"><h2>已撤销的 OBS</h2><p>文件与连接配置仍然保留。</p>{state.archivedCandidates.map(i=><div key={i.id}><strong>{i.name}</strong><button disabled={busy} onClick={()=>void act("restore-candidate",{id:i.id})}>恢复配置</button></div>)}</section>}
    {state && !state.dataRoot && <section className="desktop-form"><h2>选择 LiveNest 数据位置</h2><p>选择保存直播数据的父文件夹，程序自动创建 LiveNest 文件夹。</p><button className="btn-primary" disabled={busy} onClick={()=>void act("directory")}>选择保存位置</button></section>}
    {readError && <ProblemCard problem={makeProblem("CLOUD_UNAVAILABLE",readError,{stage:"读取本机状态",outcome:"rejected"})} onRefresh={()=>void act("check")} />}
    {!inline && visibleError && <ProblemCard problem={problem || makeProblem("DESKTOP",visibleError)} onRefresh={()=>void act("check")} onHelp={()=>{setHelpTopic("recovery");setPage("帮助");}} />}
    {state?.problems?.map((p,index)=><ProblemCard key={p.code+index} problem={p} objectName={instances.find(i=>i.id===p.target.instanceId)?.name || "本机"} onRefresh={()=>void act("check")} />)}
    {!state && <p role="status">正在读取本机配置…</p>}
    {state && page === "设备配置" && <div className="setup-list">
      {step(1, "检查电脑", computer, <><div className="check-list">{state.checks.filter(c=>!c.instanceId).map(c => <div key={c.id}><div className="check-row"><span>{c.label}</span><span className={"setup-state " + c.status}>{c.status === "ready" ? "正常" : c.status === "pending" ? "待检查" : "需要处理"}</span></div>{c.message && <p className={"check-message " + c.status}>{c.message}</p>}{c.action && <button disabled={busy} onClick={() => c.action === "help" ? setPage("帮助") : void act(c.action === "launch" ? "prepare" : c.action === "repair" ? "repair-managed" : c.action === "firewall" ? "firewall" : "diagnose-obs", {id:c.instanceId})}>{c.action === "launch" ? "启动并检查" : c.action === "repair" ? "修复连接（先关闭此 OBS）" : c.action === "firewall" ? "打开防火墙设置" : c.action === "help" ? "查看操作步骤" : "重新检查"}</button>}</div>)}</div><button disabled={busy} onClick={() => void act("check")}>检查电脑</button></>)}
      {step(2, "准备 OBS", obs, <><p>LiveNest 数据位置：<span className="desktop-path">{state.dataRoot || "尚未选择"}</span></p>{state.dataNotice && <p>{state.dataNotice}</p>}<div>{instances.map(i=><div key={i.id}>{i.name}　{fresh.some(s=>s.instance.id===i.id&&s.dashboard.obs.ready)?"控制已连接":"控制待检查"}</div>)}</div>{state.checks.filter(c=>c.instanceId&&c.status!=="ready").map(c=><ProblemCard key={c.id} problem={makeProblem(({"not-listening":"OBS_NOT_LISTENING","not-running":"OBS_NOT_RUNNING","port-conflict":"OBS_PORT"}[c.code || ""] || c.code?.toUpperCase().replaceAll("-","_") || "OBS_CONFIG"),c.message||"OBS 待检查",{domain:"obs",target:{instanceId:c.instanceId},stage:c.label})} onRefresh={()=>void act("diagnose-obs",{id:c.instanceId})} onSettings={()=>{setHelpTopic("obs");setPage("帮助");}} />)}{!instances.length ? <ObsPicker state={state} busy={!!busy} act={act}/> : <button onClick={()=>setPage("本机 OBS")}>管理 OBS</button>}</>)}
      {step(3, "连接网页", online, <>{online ? <p>本机已连接网页工作台</p> : !state.paired || pairingExpired ? <><button onClick={() => void act("web")}>打开网页，获取配对码 ↗</button>{pairingForm()}</> : <><p>正在等待连接，原配对已保留。</p><button disabled={busy} onClick={() => void act("start")}>重新连接</button><details><summary>粘贴新的配对码</summary>{pairingForm()}</details></>}</>)}
      {step(4, "连接频道", channel, <><div>{fresh.map(s => <div key={s.instance.id}>{s.instance.name}　{s.dashboard.youtube.error ? "查询受阻："+s.dashboard.youtube.error : s.dashboard.youtube.connected ? s.dashboard.youtube.channel : "尚未授权"}</div>)}</div><button disabled={!state.paired} onClick={() => void act("web")}>前往网页授权 ↗</button></>)}
      {step(5, "准备素材", media, <><div>{fresh.map(s => <div key={s.instance.id}>{s.instance.name}　{s.dashboard.media.error || `视频 ${s.dashboard.media.videos.length} · 音乐 ${s.dashboard.media.music.length}`}</div>)}</div><button disabled={!state.paired} onClick={() => void act("web")}>前往网页选择素材 ↗</button></>)}
      {step(6, "完成检查", complete, <><p>{complete ? "配置就绪，可以前往网页工作台。" : [!computer&&"检查电脑环境",!obs&&"恢复对应 OBS 控制连接",!online&&"连接网页",!channel&&"检查频道授权与查询",!media&&"检查视频与音乐目录"].filter(Boolean).join("；")}</p><button className="btn-primary" disabled={!complete} onClick={() => void act("web")}>打开网页工作台 ↗</button></>)}
    </div>}
    {state && page === "本机 OBS" && <>{activity?.step === 2 && feedback()}{instances.map(i => <section className="desktop-instance" key={i.id}><div className="setup-title"><h2>{i.name}</h2><span className={"setup-state " + (i.initialized ? "ready" : "")}>{i.initialized ? "已配置" : "待配置"}</span></div>{fresh.filter(s=>s.instance.id===i.id&&s.dashboard.obs.problem).map(s=><ProblemCard key={i.id} problem={s.dashboard.obs.problem!} objectName={i.name} onRefresh={()=>void act("diagnose-obs",{id:i.id})} onSettings={()=>{setHelpTopic("obs");setPage("帮助");}} />)}<details><summary>OBS 详情与修复</summary><p className="desktop-path">{i.exe}</p>{state.paired && <p>{fresh.some(s=>s.instance.id===i.id&&s.dashboard.youtube.connected)?"频道已连接":"下一步：在网页为此 OBS 连接独立频道"} · {fresh.some(s=>s.instance.id===i.id&&s.dashboard.media.videos.length&&s.dashboard.media.music.length)?"素材已准备":"为此 OBS 选择视频和音乐"}<button disabled={busy} onClick={()=>void act("web",{id:i.id})}>前往 {i.name} 网页配置 ↗</button></p>}<div className="desktop-actions"><span>端口 {i.port}</span>{i.managed && <button disabled={busy} onClick={() => void act("repair-managed", { id: i.id })}>修复连接（先关闭 OBS）</button>}<button disabled={busy} onClick={() => void act("prepare", { id: i.id })}>启动并检查</button><input aria-label={i.name + "名称"} defaultValue={i.name} maxLength={80} onBlur={e => { if (e.target.value.trim() && e.target.value !== i.name) void act("rename", { id: i.id, name: e.target.value }); }} /></div></details></section>)}<ObsPicker state={state} busy={!!busy} act={act} /></>}
    {page === "帮助" && <Help key={helpTopic} initialTopic={helpTopic} />}
    {state && page === "设置" && <><SettingsPanel state={{...state, update: localUpdates.state?.update || state.update}} busy={!!busy || localUpdates.pending || !!localUpdates.state?.busy} act={act} />{localUpdates.error && <p role="alert">{localUpdates.error}</p>}</>}
    </main></div></>;
}
