/** OBS 的常驻启动、只读检查入口与目标就地反馈；不依赖展开详情或设备已配对。 */
"use client";
import { useId, useState, type ReactNode } from "react";
import type { Check, DesktopAction, DesktopActivity, PublicInstance } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import ProblemCard from "../../src/app/components/problem-card";
import { CheckMarkIcon, AlertCircleIcon, RefreshIcon, ChevronDownIcon } from "../../src/app/components/icons";
import { obsCheckProgressView, obsStartupView } from "./obs-startup-state";
import { obsDiagnosisLabels } from "../../src/shared/obs-startup";
import ObsCheckProgress from "./obs-check-progress";
import styles from "./obs-startup.module.css";

/** 按不可变实例 ID 发起操作；状态与时刻组成一组，复查和详情分级，操作完成不等同于连接成功。 */
export default function ObsInstanceControls({ instance, check, snapshot, activity, diagnosis, disabled, act, help, now, readFresh, refresh }: {
  instance: PublicInstance; check?: Check; snapshot?: AgentSnapshot; activity?: DesktopActivity; diagnosis?: DesktopActivity; disabled: boolean;
  now: number; readFresh: boolean; refresh: () => void;
  act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean>; help: () => void;
}) {
  const current = activity?.action === "launch-obs" && activity.instanceId === instance.id ? activity : undefined;
  const view = obsStartupView(instance.id, current, check, snapshot, now, readFresh);
  const progress = current?.obsStartup;
  const elapsed = current ? Math.max(0, Math.floor(((view.running ? now : current.endedAt || current.problem?.observedAt || now) - current.startedAt) / 1000)) : 0;
  const diagnosing = diagnosis?.status === "running";
  const checking = diagnosing ? diagnosis : view.running ? current : undefined;
  const checkView = checking ? obsCheckProgressView(checking, now, readFresh) : undefined;
  const diagnosisTimedOut = diagnosis?.status === "complete" && check?.instanceId === instance.id && check.code === "OBS_DIAGNOSIS_TIMEOUT" && (check.checkedAt || 0) >= diagnosis.startedAt && !view.ready;
  const title = diagnosing ? checkView?.unknown ? "检查结果暂未更新" : obsDiagnosisLabels[diagnosis.obsDiagnosis?.phase || "process"] : diagnosisTimedOut ? "本轮连接检查已超时" : view.title;
  const diagnosisEndedAt = diagnosis?.endedAt || diagnosis?.problem?.observedAt;
  const recentDiagnosis = !!diagnosisEndedAt && Math.max(0, now - diagnosisEndedAt) < 4000;
  const diagnosisResult = recentDiagnosis ? diagnosisTimedOut ? "检查已超时" : diagnosis?.status === "complete" ? "检查完成" : diagnosis?.status === "failed" ? "检查未完成" : "" : "";
  const recheckText = diagnosing ? "正在检查…" : diagnosisResult === "检查完成" ? "检查完成" : "重新检查";
  const hasStartupDetails = current && current.status !== "cancelled";
  const heading = <div className={styles.statusGroup} data-obs-status-group>
    {checking ? checkView?.unknown ? <AlertCircleIcon className={styles.statusIcon} aria-hidden="true" /> : <span className={styles.spinner} aria-hidden="true" /> : view.ready ? <span className={styles.readyBadge} aria-hidden="true"><CheckMarkIcon /></span> : view.unknown || view.showFailure ? <AlertCircleIcon className={styles.statusIcon} aria-hidden="true" /> : null}
    <div className={styles.statusText}><div role="status" aria-live="polite" className={styles.heading}>{title}</div>
      {view.ready && !checking && <p className={styles.confirmedAt} aria-live="off">最近确认 <time data-obs-confirmed-time dateTime={new Date(view.latest!.at).toISOString()}>{new Date(view.latest!.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></p>}
    </div>
  </div>;
  const actions = <div className={styles.actions}>
    {view.showLaunch && !diagnosing && <button className="btn-primary" disabled={disabled} aria-label={"启动并检查 " + instance.name} onClick={() => void act("launch-obs", { id: instance.id })}>启动并检查</button>}
    {!view.running && <button className={styles.recheck} disabled={disabled || diagnosing} aria-busy={diagnosing} aria-label={(diagnosing ? "正在检查，" : diagnosisResult === "检查完成" ? "检查完成，" : "") + "重新检查 " + instance.name} onClick={() => void act("diagnose-obs", { id: instance.id })}><RefreshIcon aria-hidden="true" />{recheckText}</button>}
    <span role="status" aria-live="polite" className="visually-hidden">{diagnosing ? "正在检查 " + instance.name + " 的控制连接" : diagnosisResult ? instance.name + " " + diagnosisResult : ""}</span>
    {view.running && checkView?.unknown && <button onClick={refresh}>重新读取状态</button>}
    {!view.ready && <button className="btn-ghost" onClick={help}>连接帮助</button>}
  </div>;
  return <div className={"obs-instance-controls " + styles.feedback} data-instance-id={instance.id} data-startup-state={diagnosing ? "diagnosing" : view.running ? view.unknown ? "unknown" : view.slow ? "slow" : "running" : view.recovered ? "recovered" : view.ready ? "ready" : view.showFailure ? "failed" : "idle"}>
    <div className={styles.summary}>{heading}{actions}</div>
    {checking && <ObsCheckProgress activity={checking} now={now} readFresh={readFresh} />}
    {diagnosing && checkView?.unknown && <button onClick={refresh}>重新读取状态</button>}
    {view.running && view.slow && !view.unknown && <p role="status" className={styles.notice}>连接等待较久，检查仍在继续。可查看 OBS 的控制服务设置，无需重复启动。</p>}
    {!diagnosing && view.recovered && <p className={styles.notice}>{current?.problem?.code === "OBS_READY" ? "上次连接检查超时；刚刚重新检测到控制已连接。" : "上次连接检查未完成；刚刚重新检测到控制已连接。"}</p>}
    {!diagnosing && view.showFailure && current?.problem && <ProblemCard problem={current.problem} objectName={instance.name} />}
    {(view.ready || hasStartupDetails || diagnosing) && <ObsCheckDetails key={checking ? "checking" : view.ready ? "connected" : "history"}>
      {checking ? <><p>{checkView?.observation}</p><p>倒计时为本轮检查的超时上限。到期停止检查，不关闭 OBS，也不会自动开播。</p></> :
      view.ready ? <dl className={styles.detailFacts} aria-live="off">
        <div><dt>OBS 控制连接</dt><dd className={styles.connectedValue}>已连接</dd></div>
        <div><dt>配置端口</dt><dd>{instance.port}</dd></div>
        <div><dt>最近确认</dt><dd><time dateTime={new Date(view.latest!.at).toISOString()}>{new Date(view.latest!.at).toLocaleString("zh-CN", { hour12: false })}</time></dd></div>
        {current?.status === "complete" && !view.recovered && <div><dt>启动检查用时</dt><dd data-obs-startup-duration>{elapsed} 秒</dd></div>}
      </dl> : current && <>
        <p>{progress?.observation || current.stage}</p>
        <p>本轮最多等待 60 秒；到期停止检查，不关闭 OBS，也不会自动开播。</p>
        {view.showFailure && <p>本次检查用时 {elapsed} 秒。处理后请先重新检查当前状态。</p>}
      </>}
    </ObsCheckDetails>}
  </div>;
}

/** 摘要中的次要详情入口与关联区域；模式切换时由 key 重置展开状态，不替换复查控件。 */
function ObsCheckDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <button type="button" id={id + "-toggle"} className={styles.detailToggle} data-obs-details-toggle aria-expanded={open} aria-controls={id + "-panel"} onClick={() => setOpen(!open)}>查看详情<ChevronDownIcon aria-hidden="true" /></button>
    <div id={id + "-panel"} className={styles.detailPanel} data-obs-details-panel role="region" aria-labelledby={id + "-toggle"} hidden={!open}>{children}</div>
  </>;
}
