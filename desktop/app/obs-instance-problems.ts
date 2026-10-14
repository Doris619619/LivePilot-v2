/** 合并实例检查与 Agent 观测，避免启动中的临时连接状态被误报为最终故障。 */
import type { Check, DesktopActivity } from "../../src/shared/desktop";
import type { AgentSnapshot } from "../../src/shared/remote";
import { makeProblem, type Problem } from "../../src/shared/problems";

/** 启动只接管本实例连接反馈；网络保护等独立检查保留，结束后采用时间最新的连接证据。 */
export function obsInstanceProblems(id: string, checks: Check[], snapshot: AgentSnapshot | undefined, activity: DesktopActivity | undefined, now: number): Problem[] {
  const launch = activity?.action === "launch-obs" && activity.instanceId === id ? activity : undefined;
  const network = checks.find(check => check.id === "network-" + id);
  const freshSnapshot = snapshot?.instance.id === id && now - snapshot.observedAt < 20_000 ? snapshot : undefined;
  const snapshotIsNewer = !!freshSnapshot && (!network?.checkedAt || freshSnapshot.observedAt >= network.checkedAt);
  const failureAt = launch?.status === "failed" ? launch.problem?.observedAt || launch.startedAt : 0;
  const problems = checks.filter(check => {
    if (check.instanceId !== id || check.status === "ready" || check.code === "not-running") return false;
    // 入站保护是独立检查，不因 OBS 已连接或正在启动而消失。
    if (check.code === "firewall-unconfirmed") return true;
    if (check.checkedAt && now - check.checkedAt >= 20_000) return false;
    if (check.id !== "network-" + id) return true;
    return launch?.status !== "running" && !snapshotIsNewer && (!failureAt || (check.checkedAt || 0) > failureAt);
  }).map(check => ({
    ...makeProblem(({ "not-listening": "OBS_NOT_LISTENING", "not-running": "OBS_NOT_RUNNING", "port-conflict": "OBS_PORT" } as Record<string, string>)[check.code || ""] || check.code?.toUpperCase().replaceAll("-", "_") || "OBS_CONFIG", check.message || "OBS 待检查", { domain: "obs", target: { instanceId: id }, stage: check.label }),
    ...(check.checkedAt ? { observedAt: check.checkedAt } : {}),
  }));
  const problem = freshSnapshot?.dashboard.obs.problem;
  if (problem && snapshotIsNewer && launch?.status !== "running" && (!failureAt || freshSnapshot.observedAt > failureAt)) problems.push(problem);
  return problems;
}
