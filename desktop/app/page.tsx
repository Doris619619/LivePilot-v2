/** 本机配置工作区，复用网站外观；所有系统操作由受限桌面桥接执行。 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
import ObsSetupList from "./obs-setup-list";
import ComputerConnection from "./computer-connection";
import ObsInstanceControls from "./obs-instance-controls";
import ManualConnection from "./manual-connection";
import { UpdateProvider, useLocalUpdates } from "./local-updates";
declare global { interface Window { liveNest?: DesktopBridge } }
const pages = ["设备配置", "本机 OBS", "帮助", "设置"] as const;
/** 电脑只配对一次，每个 OBS 独立呈现准备状态。 */
export default function Page() { return <UpdateProvider><Login>{(logout, username) => <Desktop logout={logout} username={username} />}</Login></UpdateProvider>; }
/** 登录后的配置界面持续读取后台状态。 */
function Desktop({ logout, username }: { logout: () => Promise<void>; username: string }) {
  const localUpdates = useLocalUpdates();
  const [page, setPage] = useState<(typeof pages)[number]>("设备配置"); const [state, setState] = useState<DesktopState>();
  const [now, setNow] = useState(0); const [lastRead, setLastRead] = useState(0); const [readError,setReadError] = useState<Problem>(); const [problem,setProblem] = useState<Problem>(); const [helpTopic,setHelpTopic] = useState("obs");
  const [failedActivity,setFailedActivity] = useState<DesktopActivity>();
  const [selectedObs, setSelectedObs] = useState<string>();
  const [error, setError] = useState(""); const [pending, setPending] = useState(false); const [invitation, setInvitation] = useState("");

  const reading = useRef(false); const mounted = useRef(false); const revision = useRef(0); const seenAgent = useRef<string | undefined>(undefined);
  /** 只读重试不执行电脑诊断；迟到的旧快照不能覆盖新的操作结果。 */
  const load = useCallback(async () => {
    if (reading.current) return; reading.current = true; const started = revision.current;
    try {
      if (!window.liveNest) throw new Error();
      const result = window.liveNest.readState ? await window.liveNest.readState() : { ok: true as const, state: await window.liveNest.state() };
      if (!mounted.current || started !== revision.current) return;
      if (result.ok) {
        if (seenAgent.current && !result.state.paired) { setError(""); setProblem(undefined); setFailedActivity(undefined);  }
        seenAgent.current = result.state.agentId; setState(result.state); setLastRead(Date.now()); setReadError(undefined);
      }
      else { setReadError(result.problem); if (["AUTH", "FORBIDDEN", "PAIR_IDENTITY"].includes(result.problem.code)) setState(undefined); }
    } catch { if (mounted.current && started === revision.current) setReadError(makeProblem("DESKTOP_IPC", "客户端暂时无法读取本机状态，请重新读取；当前无法确认设备连接状态。", { source: "desktop", stage: "读取本机状态", outcome: "rejected" })); }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true; const initial = setTimeout(() => void load(), 0);
    const clock = setInterval(() => setNow(Date.now()), 1000); const timer = setInterval(() => void load(), 2000);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); clearInterval(clock); };
  }, [load]);
  /** 写操作去重，失败保留表单，成功后采用宿主最新快照。 */
  async function act(action: DesktopAction, input?: Record<string, unknown>) {
    if (["update-check", "update-download", "update-install", "update-apply"].includes(action)) return localUpdates.act(action);
    if (pending) return false; revision.current++; setProblem(undefined); setFailedActivity(undefined); setPending(true);   setError("");
    if (action !== "web") setState(previous => previous && ({ ...previous, activity: { instanceId: typeof input?.id === "string" ? input.id : undefined, action, step: activityStep(action), status: "running", stage: "正在检查操作条件", startedAt: now } }));
    try { if (!window.liveNest) throw new Error("桌面连接不可用。"); const result=await window.liveNest.act(action,input); if(!result.ok){const message=result.problem.message+(result.fields?" · "+Object.entries(result.fields).map(([key,value])=>({port:"端口",password:"密码",name:"名称"}[key]||key)+"："+value).join("；"):"");const failure={...result.problem,message};setFailedActivity({action,instanceId:failure.target.instanceId || (typeof input?.id==="string"?input.id:undefined),step:activityStep(action),status:"failed",stage:failure.stage,attemptId:failure.attemptId,startedAt:failure.observedAt,problem:failure,message});setProblem(failure);setError(message);const field=Object.keys(result.fields||{})[0];if(field)document.querySelector<HTMLInputElement>('[name="'+CSS.escape(field)+'"]')?.focus();return false;} setState(result.state);setReadError(undefined);setLastRead(Date.now());if(!result.cancelled && action==="pair")setInvitation("");return !result.cancelled; }
    catch { const failure=makeProblem("DESKTOP_IPC","本机操作结果未确认，请先重新读取原对象状态。",{target:{instanceId:typeof input?.id==="string"?input.id:undefined}});setProblem(failure);setError(failure.message);setFailedActivity({action,instanceId:failure.target.instanceId,step:activityStep(action),status:"failed",stage:failure.stage,startedAt:failure.observedAt,problem:failure,message:failure.message});return false; }
    finally { revision.current++; setPending(false);  }
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
  const obsConfigured = instances.length > 0 && instances.every(i => i.initialized);
  const feedback = !activity || activity.action === "launch-obs" ? null : activity.status === "failed" ? <ProblemCard problem={activity.problem || problem || makeProblem("DESKTOP",activity.message || "此步骤未完成",{target:{instanceId:activity.instanceId},stage:activity.stage,attemptId:activity.attemptId})} objectName={instances.concat(candidates).find(i=>i.id===activity.instanceId)?.name} disabled={!!busy} onRefresh={()=>void act(activity.instanceId ? "diagnose-obs" : "check",activity.instanceId ? {id:activity.instanceId} : undefined)} onHelp={()=>{setHelpTopic(activity.step===2?"obs":"recovery");setPage("帮助");}} /> : <SetupFeedback activity={activity} now={now} disabled={!!busy} help={()=>setPage("帮助")} />;
  /** 两处页面复用同一指定实例启动入口，失败和阶段保留在原目标旁。 */
  function controls(instance: DesktopState["instances"][number]) {
    return <ObsInstanceControls instance={instance} check={state?.checks.find(c=>c.id==="network-"+instance.id)} snapshot={fresh.find(s=>s.instance.id===instance.id)} activity={activity} disabled={!!busy} act={act} help={()=>{setHelpTopic("obs");setPage("帮助");}} />;
  }
  /** 跨页返回原实例配置，键盘焦点和滚动位置保持明确。 */
  function openConfiguration(id?: string) {
    setPage("设备配置"); setSelectedObs(id);
    requestAnimationFrame(()=>{const target=document.getElementById(id?"setup-obs-"+id:"obs-setup");target?.scrollIntoView({block:"start"});target?.focus();});
  }
  /** 检查结果紧贴所属 OBS，不把多个实例的故障堆在列表底部。 */
  function instanceChecks(id: string) {
    return state?.checks.filter(c=>c.instanceId===id && c.status!=="ready" && c.code!=="not-running" && (!c.checkedAt || now-c.checkedAt<20_000) && !(activity?.action==="launch-obs" && activity.instanceId===id && activity.status==="failed" && (c.checkedAt || 0)<=activity.startedAt)).map(c=><ProblemCard key={c.id} problem={makeProblem(({"not-listening":"OBS_NOT_LISTENING","not-running":"OBS_NOT_RUNNING","port-conflict":"OBS_PORT"}[c.code || ""] || c.code?.toUpperCase().replaceAll("-","_") || "OBS_CONFIG"),c.message||"OBS 待检查",{domain:"obs",target:{instanceId:id},stage:c.label})} objectName={instances.find(i=>i.id===id)?.name} onRefresh={()=>void act("diagnose-obs",{id})} onSettings={()=>{setHelpTopic("obs");setPage("帮助");}} />);
  }
  /** 配置入口集中在设备配置；日常启动页只提供返回该实例的链接。 */
  function instanceSettings(i: DesktopState["instances"][number]) {
    return <details><summary>高级设置与技术报告</summary><p className="desktop-path">{i.exe}</p><p>控制端口：{i.port}</p><label className="field-group">{i.name} 名称<input aria-label={i.name+"名称"} disabled={busy} defaultValue={i.name} maxLength={80} onBlur={e=>{if(e.target.value.trim() && e.target.value!==i.name)void act("rename",{id:i.id,name:e.target.value});}} /></label>{i.managed?<button disabled={busy} onClick={()=>void act("repair-managed",{id:i.id})}>修复 {i.name} 连接（先关闭此 OBS）</button>:<ManualConnection instances={[i]} disabled={!!busy} act={act}/>}</details>;
  }
  return <><header className="app-header"><div className="header-container"><div className="brand-section"><span aria-hidden="true" style={{ color: "var(--accent-primary)", fontSize: 24 }}>◉</span><span className="brand-name">LiveNest</span><span className="brand-tag">Studio</span></div><div className="desktop-actions desktop-header-actions">{localUpdates.state && <UpdateEntry update={localUpdates.state.update} busy={localUpdates.pending || localUpdates.state.busy} act={localUpdates.act} error={localUpdates.error} />}<button className="btn-ghost" onClick={() => void act("web")}>打开网页工作台 ↗</button><span>{username}</span><button className="btn-ghost" onClick={() => void logout()}>退出登录</button></div></div></header>
    <div className="workspace-shell"><aside className="workspace-sidebar"><nav aria-label="桌面导航">{pages.map(p => <button key={p} className={"sidebar-link desktop-nav " + (p === page ? "is-active" : "")} onClick={() => setPage(p)}>{p === "本机 OBS" ? <VideoIcon /> : <DeviceIcon />}<span>{p}</span></button>)}</nav><div className="desktop-status"><span className={"device-state " + (online ? "online" : "")}>{online ? "设备在线" : pairingExpired ? "配对已失效" : state?.agentRunning ? visibleError ? "等待重连" : "正在连接" : !state ? "状态未读取" : "尚未连接"}</span></div></aside>
    <main className="main-wrapper"><div className="workspace-heading"><h1>{page}</h1>{page === "设备配置" && <button disabled={busy} onClick={() => void load()}><RefreshIcon />重新读取</button>}</div>
    {state?.maintenance && <div className="banner" role="status">设备维护尚未确认结束，原配置已保留。<button disabled={busy} onClick={() => void act("start")}>重新连接并恢复</button></div>}
    {state && !state.dataRoot && <section className="desktop-form"><h2>选择 LiveNest 数据位置</h2><p>选择保存直播数据的父文件夹，程序自动创建 LiveNest 文件夹。</p><button className="btn-primary" disabled={busy} onClick={()=>void act("directory")}>选择保存位置</button></section>}
    {readError && <ProblemCard problem={readError} onRefresh={()=>void load()} onLogin={()=>void logout()} />}
    {!inline && visibleError && <ProblemCard problem={problem || makeProblem("DESKTOP",visibleError)} onRefresh={()=>void act("check")} onHelp={()=>{setHelpTopic("recovery");setPage("帮助");}} />}
    {state?.problems?.map((p,index)=><ProblemCard key={p.code+index} problem={p} objectName={instances.find(i=>i.id===p.target.instanceId)?.name || "本机"} onRefresh={()=>void act("check")} />)}
    {!state && !readError && <p role="status">正在读取本机配置…</p>}
    {state && page === "设备配置" && <>
      <ObsSetupList state={state} snapshots={fresh} now={now} online={online} busy={!!busy} selected={selectedObs} onSelect={setSelectedObs} act={act} controls={controls} checks={instanceChecks} settings={instanceSettings} feedback={activity?.step === 2 && feedback} connection={<ComputerConnection online={online} paired={state.paired} expired={pairingExpired} configured={obsConfigured} busy={!!busy} invitation={invitation} onInvitation={setInvitation} onWeb={()=>void act("web")} onPair={()=>void act("pair", {invitation})} onReconnect={()=>void act("start")} feedback={activity?.step === 3 && feedback}/>} additions={<>
        <ObsPicker state={state} busy={!!busy} act={act}/>
        {!!candidates.length && <section className="desktop-form"><h3>待配置 OBS</h3>{candidates.map(i => <div className="obs-config-row" key={i.id}><strong>{i.name}</strong><button disabled={busy} onClick={()=>void act("prepare", {id:i.id})}>继续配置</button><button disabled={busy} onClick={()=>void act("discard", {id:i.id})}>撤销新增</button></div>)}{!!candidates.filter(i=>!i.managed).length && <ManualConnection instances={candidates.filter(i=>!i.managed)} disabled={!!busy} act={act}/>}</section>}
        {!!state.archivedCandidates?.length && <details><summary>已撤销的 OBS</summary>{state.archivedCandidates.map(i=><div key={i.id}><strong>{i.name}</strong><button disabled={busy} onClick={()=>void act("restore-candidate",{id:i.id})}>恢复配置</button></div>)}</details>}
      </>}/>
      {state.checks.filter(c=>!c.instanceId && ["directory","node","system"].includes(c.id) && ["missing","error"].includes(c.status)).map(c=><ProblemCard key={c.id} problem={makeProblem("CONFIG",c.message || "本机配置需要检查",{source:"desktop",stage:c.label})} onRefresh={()=>void act("check")} onHelp={()=>setPage("帮助")} />)}
      <details className="technical-report"><summary>电脑技术报告</summary><p className="desktop-path">数据位置：{state.dataRoot}</p>{state.checks.filter(c=>!c.instanceId).map(c=><p key={c.id}>{c.label} · {c.status === "ready" ? "正常" : "待核对"} {c.message}</p>)}<button disabled={busy} onClick={()=>void act("check")}>重新检查电脑</button><button disabled={busy} onClick={()=>void act("firewall")}>自动配置 OBS 本机保护</button>{activity?.step === 1 && feedback}</details>
    </>}
    {state && page === "本机 OBS" && <><div className="obs-config-row"><p>在这里启动和查看 OBS；添加、命名与连接配置统一在“设备配置”。</p><button onClick={()=>openConfiguration()}>添加或配置 OBS</button></div>{!state.paired && <p>尚未连接网页，可以先启动并检查本机 OBS。</p>}{!instances.length && <p>尚未添加 OBS，请点击“添加或配置 OBS”开始。</p>}{activity?.step === 2 && feedback}{instances.map(i => <section className="desktop-instance" key={i.id}><div className="setup-title"><h2>{i.name}</h2><button onClick={()=>openConfiguration(i.id)}>配置 {i.name}</button></div>{controls(i)}{instanceChecks(i.id)}{fresh.filter(s=>s.instance.id===i.id&&s.dashboard.obs.problem).map(s=><ProblemCard key={i.id} problem={s.dashboard.obs.problem!} objectName={i.name} onRefresh={()=>void act("diagnose-obs",{id:i.id})} onSettings={()=>openConfiguration(i.id)} />)}</section>)}</>}
    {page === "帮助" && <Help key={helpTopic} initialTopic={helpTopic} />}
    {state && page === "设置" && <><SettingsPanel state={{...state, update: localUpdates.state?.update || state.update}} busy={!!busy || localUpdates.pending || !!localUpdates.state?.busy} act={act} />{localUpdates.error && <p role="alert">{localUpdates.error}</p>}</>}
    </main></div></>;
}
