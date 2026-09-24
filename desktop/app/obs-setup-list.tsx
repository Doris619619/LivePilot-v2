/** 按 OBS 组织配置，摘要常驻，仅展开一个实例的下一步和高级设置。 */
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
  const progress = rows.find(row => row.instance.id === current) || rows.find(row => !row.ready) || rows[0];
  const complete = [!!rows.length, online, !!progress?.control, !!progress?.channel, !!progress?.media];
  const nextStep = complete.findIndex(value => !value);
  /** 步骤导航定位原实例，频道和素材状态从不跨实例合并。 */
  function goToStep(index: number) {
    if (index === 0) setAdding(true);
    if (index > 1 && progress) onSelect(progress.instance.id);
    const target = index === 0 ? "obs-addition" : index === 1 ? "computer-connection" : progress ? `obs-step-${index + 1}-${progress.instance.id}` : "obs-addition";
    requestAnimationFrame(() => { const element = document.getElementById(target); element?.scrollIntoView({ block: "start", behavior: "auto" }); element?.focus(); });
  }
  return <section id="obs-setup" className="obs-workspace" tabIndex={-1}>
    <nav className="setup-progress" aria-label="配置步骤"><div className="setup-progress-caption"><strong>按这 5 步完成配置</strong><span>{progress ? `当前进度：${progress.instance.name}` : "从添加第一个 OBS 开始"}</span></div><ol>{["添加 OBS", "连接网页", "检查 OBS", "连接频道", "准备素材"].map((label, index) => <li key={label} className={complete[index] ? "is-complete" : index === nextStep ? "is-current" : ""}><button type="button" aria-current={index === nextStep ? "step" : undefined} onClick={() => goToStep(index)}><span className="setup-step-index">{index + 1}</span><span>{label}<small>{complete[index] ? "已完成" : index === nextStep ? "下一步" : "待完成"}</small></span></button></li>)}</ol></nav>
    <div id="obs-addition" className="setup-title obs-addition" tabIndex={-1}><div className="numbered-heading"><span className="setup-step-index" aria-hidden="true">1</span><div><h2>我的 OBS</h2><p>{rows.length ? `已添加 ${rows.length} 个 OBS。下方分别配置，进度互不影响。` : "先添加第一个 OBS，之后可以随时添加第二个。"}</p></div></div><button disabled={busy} aria-expanded={adding || !rows.length} onClick={() => setAdding(!adding)}>添加 OBS</button></div>
    {(adding || !rows.length || !!state.candidates?.length) && <div className="obs-add-panel">{additions}</div>}
    {connection}
    {feedback}
    {rows.map(row => { const { instance: i, dashboard } = row; const expanded = current === i.id; return <section className="obs-setup-card" id={"setup-obs-" + i.id} tabIndex={-1} key={i.id}>
      <div className="setup-title"><h3>{i.name}</h3><span className={"setup-state " + (row.ready || row.live ? "ready" : "")}>{row.label}</span></div>
      <div className="obs-status-grid" aria-label={i.name + " 准备状态"}>
        <span>控制连接 <b>{row.control ? "已连接" : "待检查"}</b></span><span>频道 <b>{row.channel ? dashboard?.youtube.channel || "已连接" : "待连接"}</b></span><span>素材 <b>{row.media ? "已备齐" : "待准备"}</b></span>
      </div>
      <div id={"obs-step-3-" + i.id} className="obs-control-step" tabIndex={-1}><div className="setup-title"><strong><span className="inline-step-number">3</span>检查 OBS</strong><span className={"setup-state " + (row.control ? "ready" : "")}>{row.control ? "已完成" : "待检查"}</span></div>{controls(i)}</div>
      <button className="btn-ghost" aria-expanded={expanded} aria-controls={"obs-detail-" + i.id} onClick={() => onSelect(expanded ? "none" : i.id)}>{expanded ? "收起配置" : row.ready ? "查看配置" : "继续配置"}</button>
      {expanded && <div id={"obs-detail-" + i.id} className="obs-detail">
        {checks(i.id)}
        <div id={"obs-step-4-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">4</span>连接频道</strong><p>{row.channel ? dashboard?.youtube.channel : dashboard?.youtube.error ? "频道暂未确认，请在网页重新查询。" : "为这个 OBS 连接独立的 YouTube 频道。"}</p></div><span className={"setup-state " + (row.channel ? "ready" : "")}>{row.channel ? "已完成" : "待完成"}</span><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置 {i.name} 频道 ↗</button></div>
        <div id={"obs-step-5-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">5</span>准备素材</strong><p>{dashboard?.media.error ? "素材暂不可读取，请在网页重新读取。" : dashboard ? `视频 ${dashboard.media.videos.length} · 音乐 ${dashboard.media.music.length}` : "为这个 OBS 准备视频和音乐。"}</p></div><span className={"setup-state " + (row.media ? "ready" : "")}>{row.media ? "已备齐" : "待完成"}</span><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置 {i.name} 素材 ↗</button></div>
        <p className="text-muted">{state.paired ? "在网页选好本次视频和音乐后开播。启动 OBS 不会自动开播。" : "先连接上方网页工作台，一台电脑只需配对一次。"}</p>
        {settings(i)}
      </div>}
    </section>; })}
  </section>;
}
