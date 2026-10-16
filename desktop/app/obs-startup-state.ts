/** OBS 操作历史与新鲜观测的展示规则；超时记录和当前连接状态分别保留。 */
import type { Check, DesktopActivity } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import { OBS_OBSERVATION_FRESH_MS, OBS_STARTUP_SLOW_MS, obsStartupLabels } from "../../src/shared/obs-startup";

/** 优先使用本轮宿主记录；IPC 失败可暂时覆盖运行态，下一次真实终态可恢复它。 */
export function obsLaunchFor(id: string, activity?: DesktopActivity, launches: DesktopActivity[] = []) {
  const saved = launches.find(item => item.instanceId === id);
  const current = activity?.action === "launch-obs" && activity.instanceId === id ? activity : undefined;
  if (!saved) return current;
  if (!current) return saved;
  if (current.attemptId && current.attemptId === saved.attemptId) {
    return saved.status !== "running" ? saved : { ...saved, ...current, startedAt: saved.startedAt, obsStartup: saved.obsStartup };
  }
  return current.startedAt >= saved.startedAt ? current : saved;
}

/** 只用目标实例的最新证据恢复连接；陈旧成功和失败前的成功都不能结算本轮。 */
export function obsStartupView(id: string, activity: DesktopActivity | undefined, check: Check | undefined, snapshot: AgentSnapshot | undefined, now: number, readFresh: boolean) {
  const local = check?.instanceId === id && check.checkedAt ? { at: check.checkedAt, ready: !!check.controlReady || check.status === "ready", running: check.code === "not-running" ? false : undefined } : undefined;
  const remote = snapshot?.instance.id === id ? { at: snapshot.observedAt, ready: snapshot.dashboard.obs.ready, running: snapshot.dashboard.obs.running } : undefined;
  const latest = remote && (!local || remote.at >= local.at) ? remote : local;
  const fresh = readFresh && latest && now - latest.at < OBS_OBSERVATION_FRESH_MS ? latest : undefined;
  const running = activity?.status === "running";
  const failed = activity?.status === "failed";
  const endedAt = activity?.endedAt || activity?.problem?.observedAt || activity?.startedAt || 0;
  const newer = !!fresh && fresh.at > endedAt;
  const recovered = failed && newer && fresh.ready;
  const progress = activity?.obsStartup;
  const probeStale = running && now - (progress?.lastProbeAt || activity.startedAt) >= OBS_OBSERVATION_FRESH_MS;
  const overdue = running && !!progress && now >= progress.deadlineAt;
  const unknown = running && (!readFresh || probeStale || overdue);
  const slow = running && now - activity.startedAt >= OBS_STARTUP_SLOW_MS;
  const ready = !running && !!fresh?.ready && (!failed || recovered);
  const showFailure = failed && !newer;
  const title = running ? unknown ? "检查结果暂未更新" : obsStartupLabels[progress?.phase || "process"]
    : recovered ? "控制连接已恢复" : ready ? "控制已连接"
    : showFailure ? activity.problem?.code === "OBS_READY" ? "本轮连接检查已超时" : "本次控制连接未确认"
    : latest?.ready ? "上次控制已连接，当前状态待确认" : latest?.running === false ? "OBS 尚未启动" : "控制连接待检查";
  // 失败后先复查；只有确定未运行或初次无观测时，突出启动入口。
  const showLaunch = readFresh && !running && !ready && ((fresh?.running === false && (!activity || newer)) || (!activity && !latest));
  return { title, running, ready, recovered, showFailure, showLaunch, unknown, slow, overdue, latest: fresh, endedAt };
}
