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
  const completeBadge = <span className="obs-complete-badge">已完成</span>;
  const rows = state.instances.map(instance => ({ instance, ...obsReadiness(instance, state.checks.find(c => c.id === "network-" + instance.id), snapshots.find(s => s.instance.id === instance.id), now) }));
  const current = selected || rows.find(row => !row.ready)?.instance.id || rows[0]?.instance.id;
  /** 步骤导航定位原实例，频道和素材状态从不跨实例合并。 */
  function goToStep(id: string, index: number) {
    onSelect(id);
    const target = `obs-step-${index + 1}-${id}`;
    requestAnimationFrame(() => { const element = document.getElementById(target); element?.scrollIntoView({ block: "start", behavior: "auto" }); element?.focus(); });
  }
  return <section id="obs-setup" className="obs-workspace" tabIndex={-1}>
    <div id="obs-addition" className="setup-title obs-addition" tabIndex={-1}><div className="numbered-heading"><div><h2>我的 OBS</h2></div></div><button disabled={busy} aria-expanded={adding || !rows.length} onClick={() => setAdding(!adding)}>添加 OBS</button></div>
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
        <div id={"obs-step-1-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">1</span>准备 OBS</strong>{!i.initialized && <p>尚未准备完成，请继续配置。</p>}</div><div className="obs-step-tools"><span className="obs-step-status">{i.initialized && completeBadge}</span><span className="obs-step-action">{!i.initialized && <button disabled={busy} onClick={()=>void act("prepare",{id:i.id})}>准备 {i.name}</button>}</span></div></div>
        <div id={"obs-step-2-" + i.id} className="obs-config-row obs-connection-step" tabIndex={-1}><div className="obs-connection-content">{connection}</div><div className="obs-step-tools"><span className="obs-step-status">{online && completeBadge}</span><span className="obs-step-action" /></div></div>
        <div id={"obs-step-3-" + i.id} className="obs-config-row obs-control-step" tabIndex={-1}><div className="obs-control-content"><div className="setup-title"><strong><span className="inline-step-number">3</span>检查 OBS</strong></div>{!row.control && controls(i)}{checks(i.id)}</div><div className="obs-step-tools"><span className="obs-step-status">{row.control && completeBadge}</span><span className="obs-step-action" /></div></div>
        {state.activity?.instanceId === i.id && feedback}
        <div id={"obs-step-4-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">4</span>连接频道</strong><p>{row.channel ? "已连接指定的 YouTube 频道。" : dashboard?.youtube.error ? "频道暂未确认，请重新查询后再配置。" : "需要连接你指定的 YouTube 频道。点击右侧“配置频道”。"}</p></div><div className="obs-step-tools"><span className="obs-step-status">{row.channel && completeBadge}</span><span className="obs-step-action"><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置频道 ↗</button></span></div></div>
        <div id={"obs-step-5-" + i.id} className="obs-config-row" tabIndex={-1}><div><strong><span className="inline-step-number">5</span>准备素材</strong><p>{dashboard?.media.error ? "素材暂不可读取，请重新打开配置。" : row.media ? "已准备一个视频和一段音乐。" : "需要准备一个视频和一段音乐。点击右侧“配置素材”。"}</p></div><div className="obs-step-tools"><span className="obs-step-status">{row.media && completeBadge}</span><span className="obs-step-action"><button disabled={busy || !state.paired} onClick={() => void act("web", { id: i.id })}>配置素材 ↗</button></span></div></div>
        {settings(i)}
      </div>}
    </section>; })}
  </section>;
}
