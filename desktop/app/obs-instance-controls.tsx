/** OBS 的常驻启动、只读检查入口与目标就地反馈；不依赖展开详情或设备已配对。 */
import type { Check, DesktopAction, DesktopActivity, PublicInstance } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import ProblemCard from "../../src/app/components/problem-card";
import { CheckCircleIcon, AlertCircleIcon } from "../../src/app/components/icons";
import { obsStartupView } from "./obs-startup-state";
import styles from "./obs-startup.module.css";

/** 按不可变实例 ID 发起操作；跨页面共享检查状态，操作完成不等同于控制连接成功。 */
export default function ObsInstanceControls({ instance, check, snapshot, activity, diagnosis, disabled, act, help, now, readFresh, refresh }: {
  instance: PublicInstance; check?: Check; snapshot?: AgentSnapshot; activity?: DesktopActivity; diagnosis?: DesktopActivity; disabled: boolean;
  now: number; readFresh: boolean; refresh: () => void;
  act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean>; help: () => void;
}) {
  const current = activity?.action === "launch-obs" && activity.instanceId === instance.id ? activity : undefined;
  const view = obsStartupView(instance.id, current, check, snapshot, now, readFresh);
  const progress = current?.obsStartup;
  const phaseIndex = ["process", "control", "verify", "ready"].indexOf(progress?.phase || "process");
  const elapsed = current ? Math.max(0, Math.floor(((view.running ? now : current.endedAt || current.problem?.observedAt || now) - current.startedAt) / 1000)) : 0;
  const diagnosing = diagnosis?.status === "running";
  const diagnosisEndedAt = diagnosis?.endedAt || diagnosis?.problem?.observedAt;
  const recentDiagnosis = !!diagnosisEndedAt && Math.max(0, now - diagnosisEndedAt) < 4000;
  const diagnosisResult = recentDiagnosis ? diagnosis?.status === "complete" ? "检查完成" : diagnosis?.status === "failed" ? "检查未完成" : "" : "";
  return <div className={"obs-instance-controls " + styles.feedback} data-instance-id={instance.id} data-startup-state={view.running ? view.unknown ? "unknown" : view.slow ? "slow" : "running" : view.recovered ? "recovered" : view.ready ? "ready" : view.showFailure ? "failed" : "idle"}>
    <div role="status" aria-live="polite" className={styles.heading + (view.ready ? " " + styles.ready : "")}>
      {view.ready ? <CheckCircleIcon aria-hidden="true" /> : view.unknown || view.showFailure ? <AlertCircleIcon aria-hidden="true" /> : view.running ? <span className={styles.spinner} aria-hidden="true" /> : null}
      <span>{view.title}</span>
    </div>
    {view.running && <ol className={styles.steps} aria-label="OBS 启动阶段">{["启动 OBS", "连接控制服务", "确认 OBS 状态"].map((label, index) => <li key={label} aria-current={index === phaseIndex ? "step" : undefined}>
      {index < phaseIndex ? <CheckCircleIcon aria-hidden="true" /> : <span className={styles.pending} aria-hidden="true" />}<span>{label}{index < phaseIndex ? " · 已确认" : ""}</span>
    </li>)}</ol>}
    {view.running && <div className={styles.meta} aria-live="off">已等待 {elapsed} 秒{progress?.lastProbeAt ? " · 最近检查完成于 " + Math.max(0, Math.floor((now - progress.lastProbeAt) / 1000)) + " 秒前" : " · 等待首次检查结果"}</div>}
    {view.running && (view.unknown || view.slow) && <p role="status" className={styles.notice}>{view.unknown ? view.overdue ? "本轮已达到检查时限，正在核对最终结果。请重新读取状态，避免重复启动。" : "暂时无法确认检查是否仍在进行。可重新读取状态，或查看连接帮助。" : "连接等待较久，检查仍在继续。可查看 OBS 的控制服务设置，无需重复启动。"}</p>}
    {view.recovered && <p className={styles.notice}>{current?.problem?.code === "OBS_READY" ? "上次连接检查超时；刚刚重新检测到控制已连接。" : "上次连接检查未完成；刚刚重新检测到控制已连接。"}</p>}
    {view.showFailure && current?.problem && <ProblemCard problem={current.problem} objectName={instance.name} />}
    <div className={styles.actions}>
      {view.showLaunch && <button className="btn-primary" disabled={disabled} aria-label={"启动并检查 " + instance.name} onClick={() => void act("launch-obs", { id: instance.id })}>启动并检查</button>}
      {!view.running && <button className="btn-ghost" disabled={disabled || diagnosing} aria-busy={diagnosing} aria-label={"重新检查 " + instance.name} onClick={() => void act("diagnose-obs", { id: instance.id })}>{diagnosing ? "正在检查…" : "重新检查"}</button>}
      <span role="status" aria-live="polite" className={styles.result + (!diagnosisResult ? " visually-hidden" : "")}>{diagnosing ? "正在检查 " + instance.name + " 的控制连接" : diagnosisResult}</span>
      {view.running && view.unknown && <button onClick={refresh}>重新读取状态</button>}
      {!view.ready && <button className="btn-ghost" onClick={help}>连接帮助</button>}
    </div>
    {(view.ready || (current && current.status !== "cancelled")) && <details key={view.ready ? "connected" : "checking"} className={styles.details}><summary>查看检查详情</summary>
      {view.ready ? <p className={styles.meta} aria-live="off">{current?.status === "complete" && !view.recovered ? `本次检查用时 ${elapsed} 秒 · ` : ""}最近确认于 {Math.max(0, Math.floor((now - view.latest!.at) / 1000))} 秒前</p> : current && <>
        <p>{progress?.observation || current.stage}</p>
        <p>本轮最多等待 60 秒；到期停止检查，不关闭 OBS，也不会自动开播。</p>
        {view.showFailure && <p>本次检查用时 {elapsed} 秒。处理后请先重新检查当前状态。</p>}
      </>}
    </details>}
  </div>;
}
