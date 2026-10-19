/** 文件用途：验证检查计时只消费宿主预算，时钟不能伪造阶段或新鲜观测。 */
import { expect, it } from "vitest";
import type { DesktopActivity } from "../src/shared/desktop";
import { obsCheckProgressView } from "../desktop/app/obs-startup-state";

const checking: DesktopActivity = { action: "diagnose-obs", instanceId: "main", step: 2, status: "running", stage: "检查端口", startedAt: 100_000, obsDiagnosis: { phase: "control", deadlineAt: 115_000, lastProbeAt: 101_000, observation: "已确认进程与端口", probeCount: 1 } };

it("counts down the host budget without advancing the phase or observation", () => {
  expect(obsCheckProgressView(checking, 101_001, true)).toMatchObject({ elapsed: 1, remaining: 14, phaseIndex: 1, unknown: false, observation: "已确认进程与端口" });
  expect(obsCheckProgressView(checking, 105_000, true)).toMatchObject({ elapsed: 5, remaining: 10, phaseIndex: 1, observation: "已确认进程与端口" });
});

it("never treats a zero countdown, expired probe or failed read as completion", () => {
  expect(obsCheckProgressView(checking, 116_000, true)).toMatchObject({ remaining: 0, unknown: true, overdue: true, phaseIndex: 1 });
  expect(obsCheckProgressView(checking, 101_000, false).unknown).toBe(true);
  const launch: DesktopActivity = { ...checking, action: "launch-obs", obsStartup: { ...checking.obsDiagnosis!, deadlineAt: 160_000 } };
  expect(obsCheckProgressView(launch, 122_000, true)).toMatchObject({ remaining: 38, unknown: true, overdue: false });
});

it("does not invent a deadline before the host publishes one or make elapsed negative", () => {
  expect(obsCheckProgressView({ ...checking, obsDiagnosis: undefined }, 99_000, true)).toMatchObject({ elapsed: 0, remaining: undefined, phaseIndex: 0, observation: "检查端口" });
});
