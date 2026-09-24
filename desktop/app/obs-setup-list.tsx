/** 每个 OBS 独立显示五步进度，一次展开一个实例的完整操作流程。 */
"use client";
import { useState, type ReactNode } from "react";
import type { DesktopState, DesktopAction, PublicInstance } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import { obsReadiness } from "../../src/shared/obs-readiness";
type Props = { state: DesktopState; snapshots: AgentSnapshot[]; now: number; online: boolean; busy: boolean; selected?: string; onSelect: (id: string) => void; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean>; controls: (item: PublicInstance) => ReactNode; checks: (id: string) => ReactNode; settings: (item: PublicInstance) => ReactNode; additions: ReactNode; connection: ReactNode; feedback: ReactNode };
/** 名称与状态紧邻所属对象；第二个实例未完成不阻挡第一个实例。 */
export default function ObsSetupList({ state, snapshots, now, online, busy, selected, onSelect, act, controls, checks, settings, additions, connection, feedback }: Props) {
  const [adding, setAdding] = useState(false);
  const rows = state.instances.map(instance => ({ instance, ...obsReadiness(instance, state.checks.find(c => c.id === "network-" + instance.id), snapshots.find(s => s.instance.id === instance.id), now) }));
  const current = selected || rows.find(row => !row.ready)?.instance.id || rows[0]?.instance.id;
  /** 步骤导航定位原实例，频道和素材状态从不跨实例合并。 */
  function goToStep(id: string, index: number) {
    onSelect(id);
    const target = `obs-step-${index + 1}-${id}`;
    requestAnimationFrame(() => { const element = document.getElementById(target); element?.scrollIntoView({ block: "start", behavior: "auto" }); element?.focus(); });
  }
  return <section id="obs-setup" className="obs-workspace" tabIndex={-1}>
    <div id="obs-addition" className="setup-title obs-addition" tabIndex={-1}><div className="numbered-heading"><div><h2>我的 OBS</h2><p>{rows.length ? "每个 OBS 都有自己的 5 步配置。选择一个，按顺序完成。" : "先添加第一个 OBS，再按它自己的 5 步完成配置。"}</p></div></div><button disabled={busy} aria-expanded={adding || !rows.length} onClick={() => setAdding(!adding)}>添加 OBS</button></div>
    {(adding || !rows.length || !!state.candidates?.length) && <div className="obs-add-panel">{additions}</div>}
    {!state.activity?.instanceId && feedback}
    {rows.map(row => { const { instance: i, dashboard } = row; const expanded = current === i.id;
      const complete = [i.initialized, online, row.control, row.channel, row.media];
      const nextStep = complete.findIndex(value => !value);
      return <section className="obs-setup-card" id={"setup-obs-" + i.id} tabIndex={-1} key={i.id}>
      <div className="setup-title"><h3>{i.name}</h3><span className={"setup-state " + ((row.ready && online) || row.live ? "ready" : "")}>{!online && !row.live ? "待连接网页" : row.label}</span></div>
      <div className="obs-status-grid" aria-label={i.name + " 准备状态"}>
        <span>控制连接 <b>{row.control ? "已连接" : "待检查"}</b></span><span>频道 <b>{row.channel ? dashboard?.youtube.channel || "已连接" : "待连接"}</b></span><span>素材 <b>{row.media ? "已备齐" : "待准备"}</b></span>
      </div>
      <nav className="setup-progress" aria-label={i.name + " 配置步骤"}><div className="setup-progress-caption"><strong>{i.name} 的 5 步配置</strong><span>{complete.filter(Boolean).length} / 5 已完成</span></div><ol>{["准备 OBS", "连接网页", "检查 OBS", "连接频道", "准备素材"].map((label, index) => <li key={label} className={complete[index] ? "is-complete" : index === nextStep ? "is-current" : ""}><button type="button" aria-current={index === nextStep ? "step" : undefined} onClick={() => goToStep(i.id, index)}><span className="setup-step-index">{index + 1}</span><span>{label}<small>{complete[index] ? "已完成" : index === nextStep ? "下一步" : "待完成"}</small></span></button></li>)}</ol></nav>
      {!expanded && controls(i)}
      <button className="btn-ghost" aria-expanded={expanded} aria-controls={"obs-detail-" + i.id} onClick={() => onSelect(expanded ? "none" : i.id)}>{expanded ? "收起配置" : row.ready && online ? "查看配置" : "继续配置"}</button>
      {expanded && <div id={"obs-detail-" + i.id} className="obs-detail">
        <p className="obs-current-guide" role="status">正在配置 {i.name} · {nextStep < 0 ? "5 步已完成" : `下一步：第 ${nextStep + 1} 步`}</p>
        <div id={"obs-step-1-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">1</span>准备 OBS</strong><p>{i.initialized ? `${i.name} 已添加，使用自己的连接配置。` : `${i.name} 尚未准备完成，请继续配置。`}</p></div><span className={"setup-state " + (i.initialized ? "ready" : "")}>{i.initialized ? "已完成" : "待完成"}</span>{!i.initialized && <button disabled={busy} onClick={()=>void act("prepare",{id:i.id})}>准备 {i.name}</button>}</div>
        <div id={"obs-step-2-" + i.id} className="obs-connection-step" tabIndex={-1}>{connection}</div>
        <div id={"obs-step-3-" + i.id} className="obs-control-step" tabIndex={-1}><div className="setup-title"><strong><span className="inline-step-number">3</span>检查 OBS</strong><span className={"setup-state " + (row.control ? "ready" : "")}>{row.control ? "已完成" : "待检查"}</span></div>{controls(i)}{checks(i.id)}</div>
        {state.activity?.instanceId === i.id && feedback}
        <div id={"obs-step-4-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">4</span>连接频道</strong><p>{row.channel ? dashboard?.youtube.channel : dashboard?.youtube.error ? "频道暂未确认，请在网页重新查询。" : "为这个 OBS 连接独立的 YouTube 频道。"}</p></div><span className={"setup-state " + (row.channel ? "ready" : "")}>{row.channel ? "已完成" : "待完成"}</span><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置 {i.name} 频道 ↗</button></div>
        <div id={"obs-step-5-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">5</span>准备素材</strong><p>{dashboard?.media.error ? "素材暂不可读取，请在网页重新读取。" : dashboard ? `视频 ${dashboard.media.videos.length} · 音乐 ${dashboard.media.music.length}` : "为这个 OBS 准备视频和音乐。"}</p></div><span className={"setup-state " + (row.media ? "ready" : "")}>{row.media ? "已备齐" : "待完成"}</span><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置 {i.name} 素材 ↗</button></div>
        <p className="text-muted">{state.paired ? "在网页选好本次视频和音乐后开播。启动 OBS 不会自动开播。" : "先连接上方网页工作台，一台电脑只需配对一次。"}</p>
        {settings(i)}
      </div>}
    </section>; })}
  </section>;
}
