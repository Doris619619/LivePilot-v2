/** OBS 候选事务回归：初始化失败、撤销、升级迁移和清单提交丢失。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Manager } from "../electron/manager";
import { separateCandidates } from "../electron/candidates";
import type { Settings } from "../electron/settings";
import { AppError } from "../src/core/errors";
const f = vi.hoisted(() => ({ sequence: 0, write: vi.fn(), rpc: vi.fn(), initialize: vi.fn(), idle: vi.fn(), start: vi.fn(), stop: vi.fn(), ready: vi.fn(), fetch: vi.fn() }));
vi.mock("../electron/data-root", () => ({ordinaryPath:vi.fn(),hasData:vi.fn()}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));
vi.mock("electron", () => ({ app: { getVersion: () => "test", getLoginItemSettings: () => ({ openAtLogin: false }) }, dialog: {}, net: { fetch: f.fetch }, shell: {} }));
vi.mock("../electron/settings", () => ({ SettingsStore: class { write = f.write; } }));
vi.mock("../electron/agent-host", () => ({ AgentHost: class { child = {}; snapshots = []; lastHeartbeat = 0; rpc = f.rpc; start = f.start; stop = f.stop; ready = f.ready; } }));
vi.mock("../electron/diagnostics", () => ({ diagnose: vi.fn().mockResolvedValue([]) }));
vi.mock("../electron/updates", () => ({ Updates: class { state = {}; } }));
vi.mock("../electron/obs-repair", () => ({ repairManagedObs: vi.fn() }));
vi.mock("../electron/obs-setup", () => ({ assertLocalIdle: f.idle, initializeObs: f.initialize, newInstance: async () => ({ id: ++f.sequence===1 ? "candidate" : "candidate"+f.sequence, name: "Candidate", managed: true, exe: "fixture", port: 4455+f.sequence, password: "secret"+f.sequence, initialized: false }) }));
let manager: Manager;
/** 重新连接回归使用合成时间，不实际等待旧会话窗口。 */
afterEach(() => vi.useRealTimers());
/** 所有磁盘、网络和 OBS 副作用均替换为合成边界。 */
beforeEach(() => {
  f.sequence=0; vi.clearAllMocks(); f.fetch.mockReset(); f.write.mockResolvedValue(undefined); f.rpc.mockResolvedValue({}); f.idle.mockResolvedValue(undefined); f.initialize.mockRejectedValue(new Error("fixture initialization failure"));
  manager = new Manager("fixture", () => {}); manager.settings = { dataRoot: "fixture", encryptionKey: "a".repeat(64), paired: true, identity: { agentId: "test", origin: "https://example.invalid", token: "b".repeat(64) }, instances: [{ id: "main", name: "Old", managed: true, exe: "fixture", port: 4455, password: "old-secret", initialized: true }] };
});
it("retains a failed candidate without publishing it and restores the old device", async () => {
  const old = structuredClone(manager.settings.instances);
  await expect(manager.act("add")).rejects.toThrow("执行结果需要核对");
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
  expect(manager.settings.candidates).toEqual([]); expect(manager.settings.archivedCandidates?.[0].password).toBe("secret1"); expect(manager.settings.identity).toEqual(identity);
  await expect(manager.act("discard", { id: "main" })).rejects.toThrow("不能撤销");
});
it("retains maintenance credentials when release is not acknowledged", async () => {
  f.rpc.mockImplementation(async route => { if (route === "maintenance-end") throw new Error("lost response"); return {}; });
  await expect(manager.act("add")).rejects.toThrow("维护恢复尚未确认"); expect(manager.settings.maintenance).toMatch(/^[a-f0-9]{64}$/);
});
it("keeps a validated candidate after an ambiguous cloud inventory commit", async () => {
  f.initialize.mockResolvedValue(undefined); f.rpc.mockImplementation(async route => { if (route === "instances") throw new Error("lost inventory reply"); return {}; });
  await expect(manager.act("add")).rejects.toThrow("执行结果需要核对");
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

/** 创建与重试是不同意图，新增不能选中旧失败候选或复制来源。 */
it("always allocates a clean candidate for add while retry targets the saved candidate",async()=>{
  manager.settings.paired=false;
  await expect(manager.act("add")).rejects.toThrow();
  manager.settings.candidates![0].sourceExe="external-source";
  f.initialize.mockResolvedValue(undefined);
  await manager.act("add");
  expect(manager.settings.instances.map(i=>i.id)).toEqual(["main","candidate2"]);
  expect(manager.settings.instances[1].sourceExe).toBeUndefined();
  expect(manager.settings.candidates?.[0].id).toBe("candidate");
  await manager.act("prepare",{id:"candidate"});
  expect(manager.settings.instances.map(i=>i.id)).toEqual(["main","candidate2","candidate"]);
  expect(f.sequence).toBe(2);
});
it("preserves existing instance and device credentials through consecutive additions",async()=>{
  manager.settings.paired=false; const old=structuredClone(manager.settings.instances[0]);const identity=structuredClone(manager.settings.identity);
  f.initialize.mockResolvedValue(undefined);await manager.act("add");await manager.act("add");
  expect(manager.settings.instances[0]).toEqual(old);expect(manager.settings.identity).toEqual(identity);
  expect(new Set(manager.settings.instances.map(i=>i.port)).size).toBe(3);
  expect(new Set(manager.settings.instances.map(i=>i.password)).size).toBe(3);
});
it("restores first-main as an editable candidate without checking its old credentials",async()=>{
  manager.settings.paired=false;manager.settings.instances=[];
  manager.settings.archivedCandidates=[{id:"main",name:"OBS 1",managed:true,exe:"fixture",port:4455,password:"original",initialized:false}];
  await expect(manager.act("add")).rejects.toThrow("继续准备第一个");expect(f.sequence).toBe(0);
  f.initialize.mockResolvedValue(undefined);await manager.act("restore-candidate",{id:"main"});
  expect(manager.settings.instances).toEqual([]); expect(manager.settings.candidates?.[0]).toMatchObject({id:"main",password:"original",initialized:false});
  expect(f.initialize).not.toHaveBeenCalled(); expect(f.idle).not.toHaveBeenCalled();
  expect(manager.settings.archivedCandidates).toEqual([]);
});
it("does not create candidates from a prepare request or while the data location is unset",async()=>{
  manager.settings.instances=[];manager.settings.paired=false;
  await expect(manager.act("prepare")).rejects.toThrow("首次使用");expect(f.sequence).toBe(0);
  manager.settings.dataRoot="";await expect(manager.act("add")).rejects.toThrow("数据位置");expect(f.sequence).toBe(0);
});
it("renames display metadata during unrelated live activity without maintenance or Agent restart", async () => {
  f.idle.mockRejectedValue(new Error("another instance is live"));
  await manager.act("rename", { id: "main", name: "New display name" });
  expect(manager.settings.instances[0].name).toBe("New display name"); expect(f.idle).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.rpc.mock.calls.map(call => call[0])).toEqual(["instance-rename"]);
});
it("keeps the saved name after local or remote rename failure", async () => {
  f.write.mockRejectedValueOnce(new Error("disk full")); await expect(manager.act("rename", { id: "main", name: "Unsaved" })).rejects.toThrow(); expect(manager.settings.instances[0].name).toBe("Old"); expect(f.rpc).not.toHaveBeenCalled();
  f.rpc.mockRejectedValueOnce(new Error("network")); await expect(manager.act("rename", { id: "main", name: "Unsaved" })).rejects.toThrow(); expect(manager.settings.instances[0].name).toBe("Old"); expect(f.write.mock.calls.at(-1)?.[0].instances[0].name).toBe("Old");
});
it("updates a formal manual connection on the same identity and rolls back on validation failure", async () => {
  manager.settings.paired = false; manager.settings.instances[0].managed = false;
  f.initialize.mockRejectedValueOnce(new Error("bad new credentials")); await expect(manager.act("repair", { id: "main", port: 4457, password: "new-password" })).rejects.toThrow(); expect(manager.settings.instances[0].password).toBe("old-secret");
  f.initialize.mockResolvedValue(undefined); await manager.act("repair", { id: "main", port: 4457, password: "new-password" }); expect(manager.settings.instances[0]).toMatchObject({ id: "main", managed: false, port: 4457, password: "new-password" });
});
it("drains the old Agent before an explicit network reconnect and does not acquire maintenance", async () => {
  vi.useFakeTimers(); const pending = manager.act("start"); await vi.advanceTimersByTimeAsync(22_000); await pending;
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.idle).not.toHaveBeenCalled();
});
it("does not spawn another Agent if draining the old one fails", async () => {
  f.stop.mockRejectedValueOnce(new Error("still draining")); await expect(manager.act("start")).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
});
it("preserves a retirement intent when the cloud reply is lost and retries the same target", async () => {
  manager.settings.instances.push({ ...manager.settings.instances[0], id: "obs_second", port: 4456 });
  f.rpc.mockImplementation(async route => { if (route === "instance-retire") throw new Error("reply lost"); return {}; });
  await expect(manager.act("retire", { id: "obs_second", confirmed: true })).rejects.toThrow(); expect(manager.settings.retirementPending).toBe("obs_second"); expect(manager.settings.retiredInstances?.[0].password).toBe("old-secret"); expect(manager.settings.instances.map(i => i.id)).toEqual(["main"]); expect(manager.settings.maintenance).toBeTruthy();
});
it.each([true, false])("reconciles retirement after restart against authoritative inventory (committed=%s)", async committed => {
  const saved = { ...manager.settings.instances[0], id: "obs_second", port: 4456 }; manager.settings.retirementPending = saved.id; manager.settings.retiredInstances = [saved];
  (manager.agent as unknown as { child?: unknown }).child = undefined;
  f.fetch.mockResolvedValueOnce(Response.json({ instances: committed ? [{ id: "main", name: "Old" }] : [{ id: "main", name: "Old" }, { id: "obs_second", name: "Old" }], retiredInstanceIds: committed ? [saved.id] : [] }));
  await manager.start();
  expect(manager.settings.retirementPending).toBeUndefined(); expect(manager.settings.instances.some(item => item.id === saved.id)).toBe(!committed); expect(f.start).toHaveBeenCalledOnce(); expect(f.rpc).not.toHaveBeenCalled();
});
it("preserves retirement intent when old Cloud cannot provide inventory recovery", async () => {
  manager.settings.retirementPending = "obs_second"; (manager.agent as unknown as { child?: unknown }).child = undefined; f.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(manager.start()).rejects.toThrow("升级 Cloud"); expect(manager.settings.retirementPending).toBe("obs_second"); expect(f.start).not.toHaveBeenCalled();
});
it.each(["unbound", "needs_reauthorization", "cleanup_pending"])("restores the original active instance after an explicit retirement refusal for a %s account", async account => {
  const second = { ...manager.settings.instances[0], id: "obs_second", port: 4456 }; manager.settings.instances.push(second);
  f.rpc.mockImplementation(async route => { if (route === "instance-retire") throw new AppError("BUSY", account + " account still associated", 409); return {}; });
  f.fetch.mockResolvedValue(Response.json({ instances: manager.settings.instances.map(({ id, name }) => ({ id, name })), retiredInstanceIds: [] }));
  await expect(manager.act("retire", { id: second.id, confirmed: true })).rejects.toMatchObject({ code: "BUSY" });
  expect(manager.settings.instances.map(i => i.id)).toEqual(["main", second.id]); expect(manager.settings.retirementPending).toBeUndefined(); expect(manager.settings.maintenance).toBeUndefined();
  expect(manager.settings.retiredInstances).toEqual([]); expect(f.rpc.mock.calls.map(call => call[0])).toEqual(["maintenance-begin", "instance-retire", "maintenance-end"]);
});
it("reconciles an unknown retirement through ordinary reconnect without repeatedly submitting the retirement", async () => {
  const second = { ...manager.settings.instances[0], id: "obs_second", port: 4456 }; manager.settings.retirementPending = second.id; manager.settings.retirementAgentId = "test"; manager.settings.retiredInstances = [second]; manager.settings.maintenance = "d".repeat(64);
  f.fetch.mockResolvedValueOnce(Response.json({ instances: [{ id: "main", name: "Old" }, { id: second.id, name: second.name }], retiredInstanceIds: [] }));
  await manager.start(); expect(manager.settings.instances).toContainEqual(second); expect(manager.settings.maintenance).toBeUndefined();
  expect(f.rpc.mock.calls.map(call => call[0])).toEqual(["maintenance-end"]); expect(f.start).toHaveBeenCalledOnce();
});
it.each([false, true])("archives an old-identity retirement before a new Agent starts (legacy=%s)", async legacy => {
  manager.settings.retirementPending = "obs_second"; if (!legacy) manager.settings.retirementAgentId = "old_agent";
  manager.settings.identity!.agentId = "fresh"; f.fetch.mockResolvedValueOnce(Response.json({ instances: [], retiredInstanceIds: [] }));
  await manager.start(); expect(manager.settings.retirementPending).toBeUndefined(); expect(manager.settings.orphanedRetirements).toEqual([expect.objectContaining({ instanceId: "obs_second" })]);
  expect(f.start).toHaveBeenCalledOnce(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(legacy ? 1 : 0);
});
it("preserves a bound retirement when its own Cloud inventory is unexpectedly empty", async () => {
  manager.settings.retirementPending = "obs_second"; manager.settings.retirementAgentId = "test"; f.fetch.mockResolvedValueOnce(Response.json({ instances: [], retiredInstanceIds: [] }));
  await expect(manager.start()).rejects.toThrow("协议不匹配"); expect(manager.settings.retirementPending).toBe("obs_second"); expect(f.start).not.toHaveBeenCalled();
});
