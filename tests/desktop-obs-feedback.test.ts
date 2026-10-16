/** OBS 启动反馈回归：等待与终态分离、时间择新、多实例隔离和独立保护检查。 */
import { expect, it } from "vitest";
import { obsInstanceProblems } from "../desktop/app/obs-instance-problems";
import type { Check, DesktopActivity } from "../src/shared/desktop";
import type { AgentSnapshot } from "../src/shared/remote";
import { makeProblem } from "../src/shared/problems";

const now = 100_000;
const waiting: DesktopActivity = { action: "launch-obs", instanceId: "main", step: 2, status: "running", stage: "正在等待控制连接", startedAt: now - 5000 };
const check: Check = { id: "network-main", instanceId: "main", label: "OBS 1", status: "error", code: "not-listening", checkedAt: now - 1000 };
/** 构造只含展示逻辑所读取字段的隔离 Agent 观测，不连接实际 OBS。 */
function snapshot(at = now, ready = false, id = "main") {
  return { instance: { id }, observedAt: at, dashboard: { obs: { ready, running: true, ...(!ready && { problem: makeProblem("OBS_NOT_LISTENING", "模拟端口未就绪", { domain: "obs", target: { instanceId: id } }) }) } } } as AgentSnapshot;
}

it("keeps transient polling and old diagnostics out of a running launch", () => {
  expect(obsInstanceProblems("main", [check], snapshot(), waiting, now)).toEqual([]);
  expect(obsInstanceProblems("main", [check], undefined, waiting, now)).toEqual([]);
});
it("preserves other instance failures and independent firewall advice while launching", () => {
  const firewall: Check = { ...check, id: "firewall-main", code: "firewall-unconfirmed", controlReady: true };
  expect(obsInstanceProblems("main", [check, firewall], snapshot(), waiting, now).map(p => p.code)).toEqual(["FIREWALL_UNCONFIRMED"]);
  expect(obsInstanceProblems("second", [], snapshot(now, false, "second"), waiting, now).map(p => p.code)).toEqual(["OBS_NOT_LISTENING"]);
});
it("does not retain an older polling failure after a successful final check", () => {
  const ready: Check = { ...check, status: "ready", code: undefined, controlReady: true, checkedAt: now };
  expect(obsInstanceProblems("main", [ready], snapshot(now - 1), { ...waiting, status: "complete" }, now)).toEqual([]);
  expect(obsInstanceProblems("main", [check], snapshot(now, true), undefined, now)).toEqual([]);
});
it("shows genuinely newer failures after success and only one latest connection error", () => {
  const ready: Check = { ...check, status: "ready", code: undefined, controlReady: true, checkedAt: now - 1 };
  expect(obsInstanceProblems("main", [ready], snapshot(), { ...waiting, status: "complete" }, now)).toHaveLength(1);
  expect(obsInstanceProblems("main", [check], snapshot(), undefined, now)).toHaveLength(1);
});
it("leaves the final timeout to the launch card without duplicating intermediate errors", () => {
  const failed: DesktopActivity = { ...waiting, status: "failed", problem: { ...makeProblem("OBS_READY", "模拟启动超时"), observedAt: now } };
  expect(obsInstanceProblems("main", [check], snapshot(now - 1), failed, now)).toEqual([]);
  expect(obsInstanceProblems("main", [], snapshot(now + 1), failed, now + 1)).toHaveLength(1);
});
it("rejects expired and wrong-instance polling evidence", () => {
  expect(obsInstanceProblems("main", [{ ...check, checkedAt: now - 20_000 }], snapshot(now - 20_000), undefined, now)).toEqual([]);
  expect(obsInstanceProblems("main", [], snapshot(now, false, "second"), undefined, now)).toEqual([]);
});
