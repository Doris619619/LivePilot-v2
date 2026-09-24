/** OBS 的常驻启动入口与目标就地反馈；不依赖展开详情或设备已配对。 */
import type { Check, DesktopAction, DesktopActivity, PublicInstance } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import ProblemCard from "../../src/app/components/problem-card";

/** 新鲜快照与本机检查按时间择新；隔离待确认不能冒充控制连接失败。 */
export function obsControlLabel(check?: Check, snapshot?: AgentSnapshot) {
  if (snapshot && (!check?.checkedAt || snapshot.observedAt >= check.checkedAt)) return snapshot.dashboard.obs.ready ? "控制已连接" : snapshot.dashboard.obs.running === false ? "尚未启动" : "控制待检查";
  if (check?.controlReady || check?.status === "ready") return "控制已连接（上次检查）";
  return check?.code === "not-running" ? "尚未启动" : "控制待检查";
}

/** 按不可变实例 ID 发起启动或只读检查，忙碌反馈只标记原目标。 */
export default function ObsInstanceControls({ instance, check, snapshot, activity, disabled, act, help }: {
  instance: PublicInstance; check?: Check; snapshot?: AgentSnapshot; activity?: DesktopActivity; disabled: boolean;
  act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean>; help: () => void;
}) {
  const current = activity?.action === "launch-obs" && activity.instanceId === instance.id ? activity : undefined;
  const starting = current?.status === "running";
  return <div className="obs-instance-controls" data-instance-id={instance.id}>
    <div className="obs-control-row"><span>{obsControlLabel(check, snapshot)}</span><div className="desktop-actions">
      <button className="btn-primary" disabled={disabled} aria-label={"启动并检查 " + instance.name} aria-busy={starting} onClick={() => void act("launch-obs", { id: instance.id })}>{starting ? "正在启动…" : "启动并检查"}</button>
      <button disabled={disabled} aria-label={"重新检查 " + instance.name} onClick={() => void act("diagnose-obs", { id: instance.id })}>重新检查</button>
    </div></div>
    {current && current.status !== "cancelled" && <p role="status">{current.stage}</p>}
    {current?.status === "failed" && current.problem && <ProblemCard problem={current.problem} objectName={instance.name} disabled={disabled} onRefresh={() => void act("diagnose-obs", { id: instance.id })} onHelp={help} onSettings={help} />}
  </div>;
}
