/** 指定 OBS 启动回归：身份绑定、跨进程互斥、无配置改写及控制与隔离状态分离。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), firewall: vi.fn(), targets: [] as string[] }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../src/core/obs/controller", () => ({ ObsController: class { disconnect = mock.disconnect; } }));
vi.mock("../src/core/obs/process", () => ({ ObsProcessManager: class { constructor(read: () => { obsExe: string }) { mock.targets.push(read().obsExe); } } }));
vi.mock("../electron/obs-startup", () => ({ connectObsForDesktop: mock.connect }));
vi.mock("../electron/obs-firewall", () => ({ inspectFirewall: mock.firewall }));
import { launchObs } from "../electron/obs-launch";
import { Store } from "@/core/storage";
import { configureCore } from "@/core/config";
import { activityStep } from "@/shared/desktop";
import type { Settings } from "../electron/settings";
import { obsStartupView } from "../desktop/app/obs-startup-state";
let root: string; let settings: Settings;
/** 使用独立数据根，不接触真实进程、设备凭据或生产控制状态。 */
beforeEach(async () => {
  vi.clearAllMocks(); mock.targets.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "ln-launch-"));
  settings = { dataRoot: root, encryptionKey: "a".repeat(64), paired: false, instances: [
    { id: "main", name: "OBS 1", port: 4455, exe: path.join(root, "first", "obs64.exe"), password: "fixture-one", initialized: true, managed: true },
    { id: "second", name: "OBS 2", port: 4456, exe: path.join(root, "second", "obs64.exe"), password: "fixture-two", initialized: true, managed: true },
  ] };
  mock.connect.mockImplementation(async (_process, _controller, report) => report({ phase: "ready", deadlineAt: Date.now() + 60_000, lastProbeAt: Date.now(), probeCount: 3 }));
});
/** 只移除本测试创建的临时目录，恢复核心配置来源。 */
afterEach(async () => { configureCore(() => process.env); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-launch-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it("launches the selected configured instance without pairing or altering inventory", async () => {
  const before = structuredClone(settings); const report = vi.fn();
  expect(await launchObs(settings, "second", report)).toMatchObject({ controlReady: true, instanceId: "second", status: "ready" });
  expect(mock.targets).toEqual([settings.instances[1].exe]); expect(mock.firewall).toHaveBeenCalledWith(settings.instances[1]);
  expect(settings).toEqual(before); expect(activityStep("launch-obs")).toBe(2);
  expect(report.mock.calls.at(-1)?.[1]).toMatchObject({ phase: "ready" });
});
it("shares the target control lock with Agent and never clears an existing lock", async () => {
  const target = new Store(path.join(root, "state", "instances", "second"));
  await target.exclusive(async () => { await expect(launchObs(settings, "second", vi.fn())).rejects.toMatchObject({ code: "BUSY" }); });
  expect(mock.connect).not.toHaveBeenCalled();
});
it("does not lock or require the other instance to be idle", async () => {
  await new Store(path.join(root, "state")).exclusive(async () => { await launchObs(settings, "second", vi.fn()); });
  expect(mock.connect).toHaveBeenCalledOnce();
});
it("rejects missing, unfinished and migrating targets before launching", async () => {
  await expect(launchObs(settings, "missing", vi.fn())).rejects.toMatchObject({ code: "OBS_CONFIG" });
  settings.instances[1].initialized = false;
  await expect(launchObs(settings, "second", vi.fn())).rejects.toMatchObject({ code: "OBS_CONFIG" });
  settings.instances[1].initialized = true; settings.maintenance = "fixture";
  await expect(launchObs(settings, "second", vi.fn())).rejects.toMatchObject({ code: "DESKTOP_BUSY" }); expect(mock.connect).not.toHaveBeenCalled();
});
it("preserves startup errors without starting independent protection checks", async () => {
  mock.connect.mockRejectedValue(Object.assign(new Error("target port occupied"), { code: "OBS_PORT" }));
  await expect(launchObs(settings, "second", vi.fn())).rejects.toMatchObject({ code: "OBS_PORT" });
  expect(mock.firewall).not.toHaveBeenCalled();
});
it("shows verified control separately from firewall advice before pairing", () => {
  expect(obsStartupView("main", undefined, { id: "network-main", instanceId: "main", label: "OBS", status: "error", code: "firewall-unconfirmed", controlReady: true, checkedAt: 1000 }, undefined, 1001, true).ready).toBe(true);
  expect(obsStartupView("main", undefined, { id: "network-main", instanceId: "main", label: "OBS", status: "pending", code: "not-running", controlReady: false, checkedAt: 1000 }, undefined, 1001, true).showLaunch).toBe(true);
});
