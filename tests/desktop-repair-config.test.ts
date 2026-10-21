/** 真实修复、配置快照与空闲检查回归；仅替换 Windows 进程和 OBS 网络边界。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, configureCore } from "../src/core/config";
import { AppError } from "../src/core/errors";
import { repairManagedObs } from "../electron/obs-repair";
import { assertLocalIdle } from "../electron/obs-setup";
import type { Settings } from "../electron/settings";
vi.mock("electron", () => ({ app: {}, safeStorage: {} }));
vi.mock("../electron/obs-ports", () => ({ freePort: async (_excluded: number[], preferred: number) => preferred }));
vi.mock("../src/core/obs/process", () => ({ ObsProcessManager: class {
  constructor(private read: typeof config) {}
  /** 每次执行真实配置回调，不能像旧测试一样绕开失效配置。 */
  async inspect() { const value = this.read(); if (!path.isAbsolute(value.obsExe)) throw new AppError("CONFIG", "missing executable"); await access(value.obsExe); return { pid: null, portPid: null }; }
} }));
let root: string; let settings: Settings;
/** 每例创建自己的便携目录，外部全局配置刻意保持不同以检测污染。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-config-repair-"));
  settings = { dataRoot: root, encryptionKey: "a".repeat(64), instances: [] };
  for (const [id, port] of [["main", 4455], ["obs_second", 4456]] as const) {
    const home = path.join(root, id); const exe = path.join(home, "bin/64bit/obs64.exe");
    await mkdir(path.dirname(exe), { recursive: true }); await writeFile(exe, "fixture"); await writeFile(path.join(home, ".livenest-owner"), id);
    const file = path.join(home, "config/obs-studio/plugin_config/obs-websocket/config.json"); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ custom: "keep", server_password: "old" }));
    settings.instances.push({ id, name: id, port, exe, password: "fixture", managed: true, initialized: true });
  }
  configureCore(() => ({ NODE_ENV: "test", LIVEPILOT_INSTANCES: "main", LIVEPILOT_INSTANCE_MAIN_NAME: "unrelated", LIVEPILOT_INSTANCE_MAIN_OBS_EXE: "unrelated-exe" }));
});
/** 清理仅限本例临时目录并恢复配置来源。 */
afterEach(async () => { configureCore(() => process.env); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-config-repair-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it.each(["single-main", "multi-main", "multi-second"])("repairs %s with the same immutable target after the maintenance callback", async kind => {
  if (kind === "single-main") settings.instances = [settings.instances[0]];
  const item = settings.instances[kind === "multi-second" ? 1 : 0];
  const before = config();
  const next = await repairManagedObs(settings, item, async () => { await assertLocalIdle(settings, item.id); });
  expect(next.id).toBe(item.id); expect(config()).toEqual(before);
  const file = path.resolve(item.exe, "../../../config/obs-studio/plugin_config/obs-websocket/config.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ server_password: "fixture", custom: "keep", server_enabled: true });
});
