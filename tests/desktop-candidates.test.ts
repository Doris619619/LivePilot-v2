/** OBS 候选事务回归：初始化失败、撤销、升级迁移和清单提交丢失。 */
import { beforeEach, expect, it, vi } from "vitest";
import { Manager } from "../electron/manager";
import { separateCandidates } from "../electron/candidates";
import type { Settings } from "../electron/settings";
const f = vi.hoisted(() => ({ write: vi.fn(), rpc: vi.fn(), initialize: vi.fn(), idle: vi.fn(), start: vi.fn(), stop: vi.fn(), ready: vi.fn(), fetch: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));
vi.mock("electron", () => ({ app: { getVersion: () => "test", getLoginItemSettings: () => ({ openAtLogin: false }) }, dialog: {}, net: { fetch: f.fetch }, shell: {} }));
vi.mock("../electron/settings", () => ({ SettingsStore: class { write = f.write; } }));
vi.mock("../electron/agent-host", () => ({ AgentHost: class { child = {}; snapshots = []; lastHeartbeat = 0; rpc = f.rpc; start = f.start; stop = f.stop; ready = f.ready; } }));
vi.mock("../electron/diagnostics", () => ({ diagnose: vi.fn() }));
vi.mock("../electron/updates", () => ({ Updates: class { state = {}; } }));
vi.mock("../electron/obs-repair", () => ({ repairManagedObs: vi.fn() }));
vi.mock("../electron/obs-setup", () => ({ assertLocalIdle: f.idle, initializeObs: f.initialize, newInstance: async () => ({ id: "candidate", name: "Candidate", managed: true, exe: "fixture", port: 4456, password: "secret", initialized: false }) }));
let manager: Manager;
/** 所有磁盘、网络和 OBS 副作用均替换为合成边界。 */
beforeEach(() => {
  vi.clearAllMocks(); f.write.mockResolvedValue(undefined); f.rpc.mockResolvedValue({}); f.idle.mockResolvedValue(undefined); f.initialize.mockRejectedValue(new Error("fixture initialization failure"));
  manager = new Manager("fixture", () => {}); manager.settings = { dataRoot: "fixture", encryptionKey: "a".repeat(64), paired: true, identity: { agentId: "test", origin: "https://example.invalid", token: "b".repeat(64) }, instances: [{ id: "main", name: "Old", managed: true, exe: "fixture", port: 4455, password: "old-secret", initialized: true }] };
});
it("retains a failed candidate without publishing it and restores the old device", async () => {
  const old = structuredClone(manager.settings.instances);
  await expect(manager.act("add")).rejects.toThrow("initialization failure");
  expect(manager.settings.instances).toEqual(old); expect(manager.settings.candidates).toHaveLength(1);
  expect(manager.settings.maintenance).toBeUndefined(); expect(f.rpc.mock.calls.map(c => c[0])).toEqual(["maintenance-begin", "maintenance-end"]);
  expect(JSON.stringify(manager.state())).not.toContain("secret");
  await manager.start(); expect(f.start).toHaveBeenCalledOnce();
});
it("retries the same candidate and never publishes a failed initialization", async () => {
  await expect(manager.act("add")).rejects.toThrow(); await expect(manager.act("prepare", { id: "candidate" })).rejects.toThrow();
  expect(manager.settings.candidates).toHaveLength(1); expect(manager.settings.instances.map(i => i.id)).toEqual(["main"]);
  expect(f.rpc.mock.calls.some(c => c[0] === "instances")).toBe(false);
});
it("archives a candidate without deleting its configuration or the old identity", async () => {
  await expect(manager.act("add")).rejects.toThrow(); const identity = structuredClone(manager.settings.identity);
  await manager.act("discard", { id: "candidate" });
  expect(manager.settings.candidates).toEqual([]); expect(manager.settings.archivedCandidates?.[0].password).toBe("secret"); expect(manager.settings.identity).toEqual(identity);
  await expect(manager.act("discard", { id: "main" })).rejects.toThrow("不能撤销");
});
it("retains maintenance credentials when release is not acknowledged", async () => {
  f.rpc.mockImplementation(async route => { if (route === "maintenance-end") throw new Error("lost response"); return {}; });
  await expect(manager.act("add")).rejects.toThrow("维护恢复尚未确认"); expect(manager.settings.maintenance).toMatch(/^[a-f0-9]{64}$/);
});
it("keeps a validated candidate after an ambiguous cloud inventory commit", async () => {
  f.initialize.mockResolvedValue(undefined); f.rpc.mockImplementation(async route => { if (route === "instances") throw new Error("lost inventory reply"); return {}; });
  await expect(manager.act("add")).rejects.toThrow("lost inventory");
  expect(manager.settings.instances.map(i => i.id)).toEqual(["main", "candidate"]); expect(manager.settings.candidates).toEqual([]); expect(manager.settings.maintenance).toBeTruthy();
});
it("migrates old uninitialized entries without changing registered IDs", () => {
  const settings = structuredClone(manager.settings) as Settings; settings.instances.push({ ...settings.instances[0], id: "failed", initialized: false });
  separateCandidates(settings); separateCandidates(settings);
  expect(settings.instances.map(i => i.id)).toEqual(["main"]); expect(settings.candidates?.map(i => i.id)).toEqual(["failed"]);
});
/** 新码交给云端验证原身份；错误目标与响应丢失都不能覆盖本机配置。 */
it("redeems a fresh invitation for the existing identity and rejects a redirected identity", async () => {
  manager.settings.identity!.origin = "https://livenest.duckdns.org";
  const original = structuredClone(manager.settings);
  const invitation = (agentId: string) => "LN1." + Buffer.from(JSON.stringify({ origin: "https://livenest.duckdns.org", agentId, code: "e".repeat(64) })).toString("base64url");
  f.fetch.mockResolvedValueOnce(Response.json({ protocol: 1, agentId: "another" }));
  await expect(manager.act("pair", { invitation: invitation("another") })).rejects.toThrow("未覆盖原身份"); expect(f.start).not.toHaveBeenCalled();
  f.fetch.mockRejectedValueOnce(new Error("network")); await expect(manager.act("pair", { invitation: invitation("another") })).rejects.toThrow("原配置已保留");
  f.fetch.mockResolvedValueOnce(Response.json({ protocol: 1, agentId: "test" })); await manager.act("pair", { invitation: invitation("another") });
  expect(manager.settings).toEqual(original); expect(JSON.parse(f.fetch.mock.calls[2][1].body)).toMatchObject({ agentId: "another", currentAgentId: "test", token: original.identity!.token }); expect(f.start).toHaveBeenCalledOnce();
});
