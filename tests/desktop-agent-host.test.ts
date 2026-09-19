/** Agent 故障回归：spawn 失败、IPC 断开、迟到 close 与并发重试不产生重复进程。 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { AgentHost } from "../electron/agent-host";
import type { Settings } from "../electron/settings";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn().mockRejectedValue(Object.assign(new Error(), { code: "ENOENT" })), mkdir: vi.fn(), unlink: vi.fn() }));
vi.mock("../electron/settings", () => ({ environment: () => ({}) }));
class Child extends EventEmitter {
  pid: number | undefined = process.pid; exitCode: number | null = null; signalCode: string | null = null; connected = true;
  send = vi.fn((_value: unknown, callback?: (error: Error | null) => void) => { callback?.(null); return true; });
}
const settings = { dataRoot: "fixture", paired: true, identity: { agentId: "test", token: "fixture", origin: "https://example.invalid" }, instances: [], encryptionKey: "a".repeat(64) } satisfies Settings;
let child: Child;
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
/** 仅模拟子进程事件，不启动用户 Agent 或接触身份配置。 */
beforeEach(() => { vi.clearAllMocks(); child = new Child(); vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child as never; }); });
it("clears a failed spawn even when Windows emits close without exit, then retries", async () => {
  const host = new AgentHost(); const failed = new Child(); failed.pid = undefined;
  vi.mocked(spawn).mockImplementationOnce(() => { queueMicrotask(() => { failed.emit("error", new Error("ENOENT")); failed.emit("close"); }); return failed as never; });
  await expect(host.start(settings, "missing", async () => {})).rejects.toThrow();
  expect(host.child).toBeUndefined(); expect(failed.send).not.toHaveBeenCalled();
  await host.start(settings, "fixture", async () => {}); expect(host.child).toBe(child);
  failed.emit("close"); expect(host.child).toBe(child);
});
it("coalesces concurrent starts and sends init only after spawn", async () => {
  const host = new AgentHost(); await Promise.all([host.start(settings, "fixture", async () => {}), host.start(settings, "fixture", async () => {})]);
  expect(spawn).toHaveBeenCalledTimes(1); expect(child.send).toHaveBeenCalledTimes(1);
  await host.start(settings, "fixture", async () => {}); expect(spawn).toHaveBeenCalledTimes(1);
});
it("rejects pending RPC on close and removes the dead reference", async () => {
  const host = new AgentHost(); await host.start(settings, "fixture", async () => {});
  const result = expect(host.rpc("maintenance-begin", {})).rejects.toThrow("关闭");
  child.emit("close"); await result; expect(host.child).toBeUndefined(); expect(host.lastHeartbeat).toBe(0);
});
it("does not start a second process after IPC error while the original PID still lives", async () => {
  const host = new AgentHost(); await host.start(settings, "fixture", async () => {});
  const result = expect(host.rpc("instances", {})).rejects.toThrow();
  child.connected = false; child.emit("error", new Error("EPIPE")); await result;
  await expect(host.start(settings, "fixture", async () => {})).rejects.toThrow("仍存在"); expect(spawn).toHaveBeenCalledTimes(1);
});
it("settles stop on close and handles synchronous spawn errors", async () => {
  const host = new AgentHost(); vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("spawn"); });
  await expect(host.start(settings, "fixture", async () => {})).rejects.toThrow("启动失败");
  await host.start(settings, "fixture", async () => {}); const stopped = host.stop(); child.emit("close"); await stopped;
});
it("passes the resolved system proxy to the spawned Node process", async () => {
  vi.stubEnv("HTTPS_PROXY", ""); vi.stubEnv("https_proxy", "");
  const resolve = vi.fn().mockResolvedValue("PROXY 127.0.0.1:7890");
  const host = new AgentHost(resolve); await host.start(settings, "fixture", async () => {});
  expect(resolve).toHaveBeenCalledWith(settings.identity.origin);
  const options = vi.mocked(spawn).mock.calls[0][2]; expect(options?.env?.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  expect(vi.mocked(spawn).mock.calls[0][1]).toContain("--use-env-proxy");
});
it("does not spawn when proxy resolution fails and permits corrected retry", async () => {
  vi.stubEnv("HTTPS_PROXY", ""); vi.stubEnv("https_proxy", "");
  const resolve = vi.fn().mockRejectedValueOnce(new Error("secret")).mockResolvedValue("DIRECT"); const host = new AgentHost(resolve);
  await expect(host.start(settings, "fixture", async () => {})).rejects.toThrow("无法读取系统代理"); expect(spawn).not.toHaveBeenCalled();
  await host.start(settings, "fixture", async () => {}); expect(spawn).toHaveBeenCalledTimes(1);
});
it("surfaces connection failure promptly, invalidates stale heartbeats, and recovers on the same process", async () => {
  vi.useFakeTimers(); const host = new AgentHost(); await host.start(settings, "fixture", async () => {});
  const ready = expect(host.ready()).rejects.toThrow("无法连接");
  child.emit("message", { type: "heartbeat", at: Date.now() });
  child.emit("message", { type: "error", message: "暂时无法连接控制端。" });
  await vi.advanceTimersByTimeAsync(500); await ready; expect(host.lastHeartbeat).toBe(0); expect(host.child).toBe(child);
  await host.start(settings, "fixture", async () => {}); expect(spawn).toHaveBeenCalledTimes(1);
  child.emit("message", { type: "heartbeat", at: Date.now() }); await host.ready(); expect(host.message).toBe("");
});
