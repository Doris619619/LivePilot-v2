/** 启动反馈模型：状态陈旧、等待过久、超时后恢复与动作层级的行为回归。 */
import { expect, it } from "vitest";
import { obsLaunchFor, obsStartupView } from "../desktop/app/obs-startup-state";
import { Activity } from "../electron/activity";
import type { Check, DesktopActivity } from "../src/shared/desktop";
import type { AgentSnapshot } from "../src/shared/remote";
import { makeProblem } from "../src/shared/problems";
const now = 100_000;
const running: DesktopActivity = { action: "launch-obs", instanceId: "main", attemptId: "a", step: 2, status: "running", stage: "等待控制服务", startedAt: 60_000, obsStartup: { phase: "control", deadlineAt: 120_000, lastProbeAt: now - 1000, probeCount: 4 } };
const failed: DesktopActivity = { ...running, status: "failed", endedAt: now - 2000, problem: { ...makeProblem("OBS_READY", "本轮超时"), observedAt: now - 2000 } };
/** 只构造目标实例的检查与必要快照，避免测试依赖整个桌面 DTO。 */
function view(activity: DesktopActivity | undefined = running, check?: Check, snapshot?: AgentSnapshot, readFresh = true) { return obsStartupView("main", activity, check, snapshot, now, readFresh); }
const connected: Check = { id: "network-main", instanceId: "main", label: "OBS", status: "ready", controlReady: true, checkedAt: now - 1000 };
it("shows a slow wait only with a recent real probe and does not offer another launch", () => {
  expect(view()).toMatchObject({ running: true, slow: true, unknown: false, showLaunch: false });
  expect(view({ ...running, obsStartup: { ...running.obsStartup!, lastProbeAt: now - 21_000 } })).toMatchObject({ unknown: true });
  expect(view(running, undefined, undefined, false)).toMatchObject({ unknown: true });
});
it("shows unknown after the host deadline instead of fabricating success or failure", () => {
  expect(view({ ...running, obsStartup: { ...running.obsStartup!, deadlineAt: now - 1 } })).toMatchObject({ unknown: true, overdue: true, showFailure: false });
});
it("recovers only from fresh evidence newer than the failed attempt", () => {
  expect(view(failed, connected)).toMatchObject({ recovered: true, ready: true, showFailure: false, showLaunch: false });
  expect(view(failed, { ...connected, checkedAt: now - 3000 })).toMatchObject({ recovered: false, showFailure: true });
  expect(view(failed, { ...connected, checkedAt: now - 25_000 })).toMatchObject({ recovered: false, ready: false });
  expect(view(failed, connected, undefined, false)).toMatchObject({ recovered: false });
  expect(view(failed, { ...connected, instanceId: "other" })).toMatchObject({ recovered: false });
});
it("does not let an older success hide a newer failed observation", () => {
  const snapshot = { instance: { id: "main" }, observedAt: now, dashboard: { obs: { ready: false, running: true } } } as AgentSnapshot;
  expect(view(failed, connected, snapshot)).toMatchObject({ recovered: false, ready: false, showFailure: false });
});
it("uses a secondary recheck after success and offers startup only when needed", () => {
  expect(obsStartupView("main", undefined, connected, undefined, now, true)).toMatchObject({ ready: true, showLaunch: false });
  expect(obsStartupView("main", undefined, undefined, undefined, now, true)).toMatchObject({ showLaunch: true });
  expect(view(failed, { ...connected, checkedAt: now, status: "pending", controlReady: false, code: "not-running" })).toMatchObject({ showLaunch: true });
  expect(view(failed, { ...connected, checkedAt: now - 3000, status: "pending", controlReady: false, code: "not-running" })).toMatchObject({ showLaunch: false });
  expect(obsStartupView("main", undefined, { ...connected, status: "error", controlReady: false, code: "port-conflict" }, undefined, now, true)).toMatchObject({ showLaunch: false });
});
it("retains the last launch across read-only checks and rejects a late old progress report", () => {
  const activity = new Activity(); activity.begin("launch-obs", "main"); const old = activity.value!.attemptId!;
  activity.startup(old, "等待控制服务", running.obsStartup!); activity.fail("本轮超时", failed.problem);
  const saved = activity.obsLaunches.get("main")!; activity.begin("diagnose-obs", "main"); activity.complete();
  expect(obsLaunchFor("main", activity.value, [...activity.obsLaunches.values()])).toEqual(saved);
  activity.begin("launch-obs", "main"); activity.startup(old, "迟到的成功", { ...running.obsStartup!, phase: "ready" });
  expect(activity.value!.obsStartup).toBeUndefined();
});
it("merges a returned failure with the original host start time and observations", () => {
  expect(obsLaunchFor("main", { ...failed, startedAt: now - 2000, obsStartup: undefined }, [running])).toMatchObject({ startedAt: running.startedAt, status: "failed", obsStartup: running.obsStartup });
  expect(obsLaunchFor("main", failed, [{ ...running, status: "complete", endedAt: now }])!.status).toBe("complete");
});
