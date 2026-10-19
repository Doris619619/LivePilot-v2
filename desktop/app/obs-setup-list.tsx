/** 文件用途：按 OBS 展示单列配置步骤，保留各实例的表单和当前步骤。 */
"use client";
import { useState, type ReactNode } from "react";
import type { DesktopState, DesktopAction, DesktopActivity, PublicInstance } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import { obsReadiness } from "../../src/shared/obs-readiness";
import { obsLaunchFor, obsStartupView } from "./obs-startup-state";
import ObsSetupSteps, { type ObsSetupStep } from "./obs-setup-steps";
import styles from "./obs-setup-steps.module.css";

type Props = { state: DesktopState; activity?: DesktopActivity; snapshots: AgentSnapshot[]; now: number; online: boolean; busy: boolean; selected?: string; onSelect: (id: string) => void; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean>; controls: (item: PublicInstance) => ReactNode; checks: (id: string) => ReactNode; settings: (item: PublicInstance) => ReactNode; additions: ReactNode; connection: (instanceId: string) => ReactNode; feedback: ReactNode };

/** 初次选择待完成实例；轮询只更新状态，已经展开的实例由调用方继续控制。 */
export default function ObsSetupList({ state, activity = state.activity, snapshots, now, online, busy, selected, onSelect, act, controls, checks, settings, additions, connection, feedback }: Props) {
  const [adding, setAdding] = useState(false);
  const rows = state.instances.map(instance => ({ instance, ...obsReadiness(instance, state.checks.find(check => check.id === "network-" + instance.id), snapshots.find(snapshot => snapshot.instance.id === instance.id), now) }));
  const [initialInstance] = useState(() => rows.find(row => !row.ready || !online)?.instance.id || rows[0]?.instance.id);
  const current = selected === undefined ? initialInstance || rows[0]?.instance.id : selected;

  return <section id="obs-setup" className={"obs-workspace " + styles.workspace} tabIndex={-1}>
    <div id="obs-addition" className="setup-title obs-addition" tabIndex={-1}><div className="numbered-heading"><div><h2>我的 OBS</h2></div></div><button disabled={busy} aria-expanded={adding || !rows.length} onClick={() => setAdding(!adding)}>添加 OBS</button></div>
    <div className="obs-add-panel" hidden={!(adding || !rows.length || !!state.candidates?.length)}>{additions}</div>
    {(!activity?.instanceId || !rows.some(row => row.instance.id === activity.instanceId)) && feedback}
    {rows.map(row => {
      const { instance, dashboard } = row;
      const expanded = current === instance.id;
      const complete = [instance.initialized, online, row.control, row.channel, row.media];
      const launch = obsLaunchFor(instance.id, activity, state.obsLaunches);
      const startup = obsStartupView(instance.id, launch, state.checks.find(check => check.id === "network-" + instance.id), snapshots.find(snapshot => snapshot.instance.id === instance.id), now, true);
      const ownActivity = activity?.instanceId === instance.id && ["running", "failed"].includes(activity.status) ? activity : undefined;
      const activityStep = ownActivity ? ["prepare", "add", "attach", "import-obs", "restore-candidate"].includes(ownActivity.action) ? 1 : ownActivity.step === 2 ? 3 : 0 : 0;
      const startupAttention = startup.running || startup.showFailure;
      const steps: ObsSetupStep[] = [
        { label: "准备 OBS", complete: complete[0], pending: "待准备", content: <div className={styles.content}><p>{instance.initialized ? "OBS 已准备好，可以继续检查控制连接。" : "准备此 OBS 的独立运行环境。"}</p>{!instance.initialized && <button disabled={busy} className="btn-primary" onClick={() => void act("prepare", { id: instance.id })}>准备 {instance.name}</button>}</div> },
        { label: "连接网页", complete: complete[1], pending: "待连接", content: connection(instance.id) },
        { label: "检查 OBS", complete: complete[2], pending: "待检查", status: startupAttention ? { text: startup.running ? "正在检查" : "检查未完成", tone: startup.running ? "running" : "error" } : undefined, content: <>{controls(instance)}{checks(instance.id)}</> },
        { label: "连接频道", complete: complete[3], pending: "待连接", status: dashboard?.youtube.error ? { text: "待重新确认", tone: "error" } : undefined, content: <div className={styles.content}><p>{row.channel ? "已连接指定的 YouTube 频道。" : dashboard?.youtube.error ? "频道暂未确认，请在网页重新查询后配置。" : "前往网页，为此 OBS 连接指定的 YouTube 频道。"}</p><button disabled={busy || !state.paired} onClick={() => void act("web", { id: instance.id })}>配置频道 ↗</button></div> },
        { label: "准备素材", complete: complete[4], pending: "待准备", status: dashboard?.media.error ? { text: "待重新确认", tone: "error" } : undefined, content: <div className={styles.content}><p>{dashboard?.media.error ? "素材暂不可读取，请在网页重新打开配置。" : row.media ? "已准备一个视频和一段音乐。" : "前往网页，为此 OBS 准备一个视频和一段音乐。"}</p><button disabled={busy || !state.paired} onClick={() => void act("web", { id: instance.id })}>配置素材 ↗</button></div> },
      ];
      if (activityStep && ownActivity && ownActivity.action !== "launch-obs") steps[activityStep - 1].status = { text: ownActivity.status === "running" ? "正在处理" : "操作未完成", tone: ownActivity.status === "running" ? "running" : "error" };
      // 电脑配对属于所有 OBS；其详细反馈在列表外层常驻，步骤标题也保留可见提示。
      if (!online && activity?.step === 3 && ["running", "failed"].includes(activity.status)) steps[1].status = { text: activity.status === "running" ? "正在连接" : "连接未完成", tone: activity.status === "running" ? "running" : "error" };
      return <section className="obs-setup-card" id={"setup-obs-" + instance.id} tabIndex={-1} key={instance.id}>
        <div className="setup-title"><h3>{instance.name}</h3><span className={"setup-state " + ((row.ready && online) || row.live ? "ready" : "")}>{!online && !row.live ? "待连接网页" : row.label}</span></div>
        {!expanded && <div className="obs-status-grid" aria-label={instance.name + " 准备状态"}><span>控制连接 <b>{row.control ? "已连接" : "待检查"}</b></span><span>频道 <b>{row.channel ? dashboard?.youtube.channel || "已连接" : "待连接"}</b></span><span>素材 <b>{row.media ? "已备齐" : "待准备"}</b></span></div>}
        {!expanded && startupAttention && controls(instance)}
        <button className="btn-ghost" aria-expanded={expanded} aria-controls={"obs-detail-" + instance.id} onClick={() => onSelect(expanded ? "none" : instance.id)}>{expanded ? "收起配置" : row.ready && online ? "查看配置" : "继续配置"}</button>
        <div id={"obs-detail-" + instance.id} className={"obs-detail " + styles.detail} hidden={!expanded}>
          <ObsSetupSteps instanceId={instance.id} steps={steps} />
          {settings(instance)}
        </div>
        {ownActivity && feedback}
      </section>;
    })}
  </section>;
}
