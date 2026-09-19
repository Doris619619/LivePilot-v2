/** 连接修复仅作用于已停止的自有 OBS；验证锁、备份、原值与并发启动保护。 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { repairManagedObs } from "../electron/obs-repair";
import { listeningAddresses, loopbackOnly } from "../electron/obs-network";
import type { Settings } from "../electron/settings";
const f = vi.hoisted(() => ({ inspect: vi.fn(), port: vi.fn() }));
vi.mock("../electron/settings", () => ({ environment: () => ({}) }));
vi.mock("../src/core/obs/process", () => ({ ObsProcessManager: class { inspect = f.inspect; } }));
vi.mock("../electron/obs-setup", () => ({ freePort: f.port }));
let root: string; let file: string; let settings: Settings;
/** 仅操作合成便携目录，密码为固定测试值。 */
beforeEach(async () => {
  vi.clearAllMocks(); root = await mkdtemp(path.join(os.tmpdir(), "ln-repair-"));
  file = path.join(root, "config/obs-studio/plugin_config/obs-websocket/config.json"); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(path.join(root, ".livenest-owner"), "main"); await writeFile(file, JSON.stringify({ server_port: 4455, server_password: "wrong", custom: "preserved" }));
  settings = { dataRoot: root, encryptionKey: "a".repeat(64), instances: [{ id: "main", name: "Main", managed: true, exe: path.join(root, "bin/64bit/obs64.exe"), initialized: true, port: 4455, password: "original" }] };
  f.inspect.mockResolvedValue({ pid: null, portPid: null }); f.port.mockResolvedValue(4455);
});
/** 删除范围固定为本测试生成的直接临时子目录。 */
afterEach(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-repair-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it("backs up connection settings, preserves password and unrelated values, and acquires the lock", async () => {
  const lock = vi.fn().mockResolvedValue(undefined);
  const candidate = await repairManagedObs(settings, settings.instances[0], lock);
  expect(lock).toHaveBeenCalledOnce(); expect(candidate.port).toBe(4455); expect(candidate.password).toBe("original");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ server_port: 4455, server_password: "original", custom: "preserved", auth_required: true });
  const backup = (await readdir(path.dirname(file))).find(n => n.includes(".backup-"))!;
  expect(JSON.parse(await readFile(path.join(path.dirname(file), backup), "utf8")).server_password).toBe("wrong");
});
it("selects a free port only on explicit repair and preserves the committed object until save", async () => {
  f.port.mockResolvedValue(4456); f.inspect.mockResolvedValue({ pid: null, portPid: 999 });
  expect((await repairManagedObs(settings, settings.instances[0], async () => {})).port).toBe(4456);
  expect(settings.instances[0].port).toBe(4455);
});
it("never modifies a running or uninspectable OBS", async () => {
  const before = await readFile(file, "utf8"); const lock = vi.fn();
  f.inspect.mockResolvedValue({ pid: 123, portPid: 123 }); await expect(repairManagedObs(settings, settings.instances[0], lock)).rejects.toThrow("关闭");
  f.inspect.mockRejectedValue(new Error("unknown")); await expect(repairManagedObs(settings, settings.instances[0], lock)).rejects.toThrow("unknown");
  expect(await readFile(file, "utf8")).toBe(before); expect(lock).not.toHaveBeenCalled();
});
it("does not mutate without a confirmed maintenance lock or if OBS restarts", async () => {
  const before = await readFile(file, "utf8");
  await expect(repairManagedObs(settings, settings.instances[0], async () => { throw new Error("denied"); })).rejects.toThrow("denied");
  f.inspect.mockResolvedValueOnce({ pid: null }).mockResolvedValue({ pid: 123 });
  await expect(repairManagedObs(settings, settings.instances[0], async () => {})).rejects.toThrow("重新运行");
  expect(await readFile(file, "utf8")).toBe(before);
});
it("refuses an unmanaged or mismatched owner directory", async () => {
  await expect(repairManagedObs(settings, { ...settings.instances[0], managed: false }, async () => {})).rejects.toThrow("手动");
  await writeFile(path.join(root, ".livenest-owner"), "another"); await expect(repairManagedObs(settings, settings.instances[0], async () => {})).rejects.toThrow("归属");
});
it("distinguishes actual wildcard IPv4/IPv6 listeners from loopback connections", () => {
  const lines = "TCP 0.0.0.0:4455 0.0.0.0:0 LISTENING 1\nTCP [::]:4455 [::]:0 LISTENING 1\nTCP 127.0.0.1:50000 127.0.0.1:4455 ESTABLISHED 2";
  expect(listeningAddresses(lines, 4455)).toEqual(["0.0.0.0", "::"]); expect(loopbackOnly(listeningAddresses(lines, 4455))).toBe(false);
  expect(loopbackOnly(["127.0.0.1", "::1"])).toBe(true); expect(loopbackOnly([])).toBe(false);
});
