/** 退役恢复的三实例真实磁盘/Cloud/会话回归；Electron、DPAPI、网络停顿及OBS端口均为合成边界。 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Manager } from "../electron/manager";
import { SettingsStore, type Settings } from "../electron/settings";
import { Shutdown } from "../electron/shutdown";
import { acceptCandidate } from "../electron/candidates";
import { RETIREMENT_INVENTORY_TIMEOUT_MS } from "../electron/retirement-inventory";
import { agentStore, createPairing, pairAgent, openSession, heartbeatAgent, listAgents } from "@/cloud/agents";
import { createPublishingAccount } from "@/cloud/publishing-accounts";
import { POST } from "@/app/api/agent/[...path]/route";
import { initialState } from "@/core/control";
import { AppError } from "@/core/errors";
import type { DesktopAction } from "@/shared/desktop";
const f = vi.hoisted(() => ({ bootstrap: "", root: "", fetch: vi.fn(), rpc: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => f.bootstrap, getVersion: () => "synthetic", getLoginItemSettings: () => ({ openAtLogin: false }) }, net: { fetch: f.fetch }, dialog: {}, shell: {} }));
vi.mock("../electron/windows-credentials", () => ({ protectWindows: async (bytes: Buffer) => bytes }));
vi.mock("../electron/updates", () => ({ Updates: class { state = {}; } }));
vi.mock("../electron/diagnostics", () => ({ diagnose: async () => [] }));
vi.mock("../electron/obs-firewall", () => ({ firewallChecks: () => [], firewallFingerprint: () => "synthetic", protectObs: async () => {} }));
vi.mock("../electron/obs-setup", () => ({ assertLocalIdle: async () => undefined, initializeObs: async () => undefined, newInstance: async () => ({ id: "fourth", name: "Fourth", initialized: false, managed: true, exe: path.join(f.root, "obs/fourth/bin/64bit/obs64.exe"), port: 4458, password: "synthetic-fourth" }) }));
vi.mock("../electron/agent-host", () => ({ AgentHost: class {
  child: unknown = {}; snapshots = []; problems = []; lastHeartbeat = 0;
  rpc = f.rpc;
  async start(settings: Settings) { await f.start(settings); this.child = {}; }
  async stop() { await f.stop(); this.child = undefined; }
  async localStop() { return initialState(); }
  async ready() {}
} }));
let root: string, manager: Manager, session: string, boot: string, saved: Settings;
const identity = { agentId: "original", origin: "https://synthetic.invalid", token: "b".repeat(64) };
/** 同一设备所有当前库存均明确空闲；未知/在播保护仍由真实Cloud维护与退役代码执行。 */
async function beat() {
  const instances = (await listAgents()).find(agent => agent.id === identity.agentId)!.instances;
  await heartbeatAgent(identity.agentId, session, instances.map(instance => ({ instance, observedAt: Date.now(), dashboard: { busy: false, state: initialState(), obs: { ready: true, running: true, streaming: false }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "private", madeForKids: false } } })));
}
/** Bearer/Host/session继续经过产品API；只有库存读取遵循既有免会话恢复入口。 */
async function post(route: string, value: unknown, current = identity, includeSession = true) {
  const response = await POST(new Request(current.origin + "/api/agent/" + route, { method: "POST", headers: { host: "synthetic.invalid", authorization: "Bearer " + current.token, "x-livepilot-agent": current.agentId, ...(includeSession ? { "x-livepilot-session": session } : {}), "content-type": "application/json" }, body: JSON.stringify(value) }), { params: Promise.resolve({ path: [route] }) });
  const data = await response.json(); if (!response.ok) throw new AppError(data.problem?.code || "CLOUD_REQUEST", data.problem?.message || data.error, response.status); return data;
}
/** 原进程与重启均读取真实SettingsStore；替代进程启动后仍执行原维护握手、严格会话清单与心跳。 */
async function restart() {
  manager = new Manager("synthetic", () => {}); manager.settings = await new SettingsStore().read(); (manager.agent as unknown as { child?: unknown }).child = undefined;
}
/** 仅推进产品明确的21秒旧会话窗口；真实文件事务和网络期限不被任意跳过。 */
async function finish<T>(work: Promise<T>): Promise<T> {
  let done = false, advanced = false; const settled = work.finally(() => { done = true; }); void settled.catch(() => {});
  for (let n = 0; !done && n < 1500; n++) { await delay(5); if (!advanced && manager.activity.value?.stage.includes("旧连接") && vi.getTimerCount()) { advanced = true; await vi.advanceTimersByTimeAsync(21_001); } }
  return settled;
}
/** 每例三实例、原身份、加密配置和Cloud约束独立落盘，不读取客户AppData。 */
beforeEach(async () => {
  vi.clearAllMocks(); root = await mkdtemp(path.join(os.tmpdir(), "ln-retirement-followup-")); f.bootstrap = path.join(root, "bootstrap"); f.root = path.join(root, "LiveNest");
  vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(root, "cloud-data")); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", identity.origin); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  const settings = await new SettingsStore().select(f.root); settings.identity = { ...identity }; settings.paired = true; settings.firewallAttempt = "synthetic";
  settings.instances = ["main", "second", "third"].map((id, index) => ({ id, name: id, managed: true, initialized: true, exe: path.join(f.root, "obs", id, "bin/64bit/obs64.exe"), port: 4455 + index, password: "synthetic-" + id })); await new SettingsStore().write(settings); saved = structuredClone(settings);
  await writeFile(path.join(f.root, "preserve.txt"), "original bytes");
  const invitation = await createPairing(identity.agentId, "Synthetic", "alice"); await pairAgent(identity.agentId, invitation.code, identity.token); boot = randomUUID(); session = (await openSession(identity.agentId, boot, settings.instances.map(({ id, name }) => ({ id, name })))).session; await beat();
  await agentStore(identity.agentId).write("capabilities.json", ["publishing-v1", "publishing-accounts-v1"]);
  f.rpc.mockImplementation((route: string, data: unknown) => post(route, data));
  f.fetch.mockImplementation(async () => Response.json(await post("instance-inventory", {}, manager.settings.identity!, false)));
  f.start.mockImplementation(async (current: Settings) => { const connected = await post("session", { protocol: 1, bootId: boot, instances: current.instances.map(({ id, name }) => ({ id, name })), ...(current.maintenance ? { maintenance: current.maintenance } : {}) }, current.identity!, false); session = connected.session; await beat(); });
  await restart(); (manager.agent as unknown as { child?: unknown }).child = {};
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
/** 只删除本例已核验的临时根；等待没有未观察拒绝，不做广泛Temp清理。 */
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-retirement-followup-")) throw Error("unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 三实例跨多个真实Cloud/DPAPI替身写入，15秒仅为整例测试预算，产品20秒期限与Cloud保护不变。 */
it.each([{ phase: "fetch", committed: false, reboot: true }, { phase: "body", committed: false, reboot: true }, { phase: "fetch", committed: true, reboot: true }, { phase: "body", committed: true, reboot: false }])("preserves second retirement through $phase timeout, other edits and restart=$reboot; committed=$committed", async ({ phase, committed, reboot }) => {
  if (!committed) await createPublishingAccount({ username: "alice", role: "customer" }, identity.agentId, "second", "Associated");
  const actualRpc = f.rpc.getMockImplementation()!; f.rpc.mockImplementation(async (route: string, data: unknown) => { const result = await actualRpc(route, data); if (route === "instance-retire" && committed) throw new AppError("AGENT_NETWORK", "Synthetic lost retirement reply"); return result; });
  const withheld = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>();
  f.fetch.mockImplementationOnce(async () => { const inventory = await post("instance-inventory", {}, identity, false); entered.resolve(); return phase === "fetch" ? withheld.promise : { ok: true, json: () => withheld.promise, syntheticInventory: inventory }; });
  const attempt = manager.act("retire", { id: "second", confirmed: true }); const observed = expect(attempt).rejects.toThrow("待核对"); await entered.promise; await vi.advanceTimersByTimeAsync(RETIREMENT_INVENTORY_TIMEOUT_MS + 1); await observed;
  const pending = await new SettingsStore().read(); expect(pending.retirementPending).toBe("second"); expect(manager.busy).toBe(false);
  const next = manager.act("retire", { id: "third", confirmed: true }); await expect(finish(next)).rejects.toMatchObject({ code: "MAINTENANCE" }); expect((await new SettingsStore().read()).retirementPending).toBe("second");
  for (const action of ["add", "prepare", "import-obs", "attach", "repair", "repair-managed", "restore-candidate", "discard", "replace-candidate", "rename", "directory"] as DesktopAction[]) await expect(manager.act(action, { id: "third", name: "New" })).rejects.toMatchObject({ code: "MAINTENANCE" });
  const candidate = { ...saved.instances[2], id: "fourth", initialized: false }; const unsafe = structuredClone(manager.settings); expect(() => acceptCandidate(unsafe, candidate)).toThrow("先恢复"); expect(candidate.initialized).toBe(false); expect(unsafe.instances.map(item => item.id)).not.toContain("fourth");
  expect(manager.settings).toEqual(pending); await manager.act("check"); await expect(manager.stopLocal("main")).resolves.toMatchObject({ phase: "idle" });
  if (phase === "fetch" && !committed) { const prompts = { confirm: async () => true, notify: async () => {}, finish: vi.fn() }; await new Shutdown(manager, prompts).request(); expect(prompts.finish).toHaveBeenCalledOnce(); expect(manager.settings.retirementPending).toBe("second"); }
  const late = { instances: saved.instances.map(({ id, name }) => ({ id, name })), retiredInstanceIds: [] }; withheld.resolve(phase === "fetch" ? Response.json(late) : late); await delay(5); expect(manager.settings.retirementPending).toBe("second");
  if (reboot) await restart(); await finish(manager.act("start"));
  expect(manager.settings.retirementPending).toBeUndefined(); expect(manager.settings.maintenance).toBeUndefined(); expect(manager.settings.instances.some(item => item.id === "second")).toBe(!committed);
  expect(manager.settings.identity).toEqual(identity); expect(manager.settings.encryptionKey).toBe(saved.encryptionKey);
  f.rpc.mockImplementation(actualRpc); await finish(manager.act("retire", { id: "third", confirmed: true })); await finish(manager.act("add"));
  expect(manager.settings.instances.map(item => item.id).sort()).toEqual(committed ? ["fourth", "main"] : ["fourth", "main", "second"]); expect((await new SettingsStore().read()).instances).toEqual(manager.settings.instances);
  expect((await listAgents())[0].instances.map(item => item.id).sort()).toEqual(manager.settings.instances.map(item => item.id).sort());
  expect((await openSession(identity.agentId, boot, manager.settings.instances.map(({ id, name }) => ({ id, name })))).session).toBeTruthy(); expect(await readFile(path.join(f.root, "preserve.txt"), "utf8")).toBe("original bytes");
}, 15_000);
/** 已发生旧版覆盖：Second未退休、Third确已退休，原身份维护凭据和完整档案均保留。 */
it("repairs a legacy mismatch without pending and then completes a strict session and another addition", async () => {
  await manager.maintenance(); await post("instance-retire", { id: "third", token: manager.settings.maintenance });
  manager.settings.retiredInstances = saved.instances.slice(1); manager.settings.instances = [saved.instances[0]]; manager.settings.inventoryPending = true; await new SettingsStore().write(manager.settings); await restart();
  await expect(openSession(identity.agentId, boot, [{ id: "main", name: "main" }])).rejects.toMatchObject({ code: "AGENT_CONFIG" });
  await finish(manager.act("start")); expect(manager.settings.instances).toContainEqual(saved.instances[1]); expect(manager.settings.instances.some(item => item.id === "third")).toBe(false); expect(manager.settings.retiredInstances).toEqual([saved.instances[2]]);
  await finish(manager.act("add")); expect(manager.settings.instances.map(item => item.id).sort()).toEqual(["fourth", "main", "second"]); expect(manager.settings.identity).toEqual(identity); expect(manager.settings.encryptionKey).toBe(saved.encryptionKey);
  expect((await openSession(identity.agentId, boot, manager.settings.instances.map(({ id, name }) => ({ id, name })))).session).toBeTruthy();
}, 15_000);
/** 故意留下旧版本已提交一半的库存形态，Cloud主实例保护和墓碑均保持真实。 */
async function legacyMismatch() {
  await manager.maintenance(); await post("instance-retire", { id: "third", token: manager.settings.maintenance });
  manager.settings.retiredInstances = saved.instances.slice(1); manager.settings.instances = [saved.instances[0]]; manager.settings.inventoryPending = true;
}
/** 旧失配仍有第四个可操作实例时，任何配置写必须先结算旧库存；恢复后原意图仍可正常执行。 */
it.each(["retire", "rename", "repair"] as const)("settles a legacy mismatch before a new %s of the fourth instance", async action => {
  await finish(manager.act("add")); const fourth = { ...manager.settings.instances.find(item => item.id === "fourth")!, managed: action !== "repair" };
  await legacyMismatch(); manager.settings.instances.push(fourth); await new SettingsStore().write(manager.settings); await restart();
  const before = await readFile(path.join(f.root, "state/desktop/settings.json"), "utf8"), input = { id: "fourth", confirmed: true, name: "Renamed fourth", port: 4460, password: "synthetic-repaired" };
  await expect(finish(manager.act(action, input))).rejects.toMatchObject({ code: "MAINTENANCE" });
  expect(await readFile(path.join(f.root, "state/desktop/settings.json"), "utf8")).toBe(before); expect(manager.settings.instances.find(item => item.id === "fourth")).toEqual(fourth); expect(manager.settings.retirementPending).toBeUndefined();
  await finish(manager.act("start")); expect(manager.settings.instances).toContainEqual(saved.instances[1]); expect(manager.settings.retiredInstances).toEqual([saved.instances[2]]); expect(manager.settings.inventoryPending).toBeUndefined();
  await finish(manager.act(action, input)); expect(manager.settings.identity).toEqual(identity); expect(manager.settings.encryptionKey).toBe(saved.encryptionKey);
  if (action === "retire") expect(manager.settings.instances.some(item => item.id === "fourth")).toBe(false);
  if (action === "rename") expect(manager.settings.instances.find(item => item.id === "fourth")?.name).toBe("Renamed fourth");
  if (action === "repair") expect(manager.settings.instances.find(item => item.id === "fourth")).toMatchObject({ port: 4460, password: "synthetic-repaired" });
  expect((await openSession(identity.agentId, boot, manager.settings.instances.map(({ id, name }) => ({ id, name })))).session).toBeTruthy(); expect((await listAgents())[0].instances.map(item => item.id).sort()).toEqual(manager.settings.instances.map(item => item.id).sort());
}, 15_000);
it.each(["missing-history", "duplicate-history", "incomplete-history", "changed-identity", "retired-active"] as const)("keeps a legacy inventory mismatch closed on %s instead of guessing original configuration", async reason => {
  await legacyMismatch();
  if (reason === "missing-history") manager.settings.retiredInstances = [saved.instances[2]];
  if (reason === "duplicate-history") manager.settings.retiredInstances!.push(saved.instances[1]);
  if (reason === "incomplete-history") manager.settings.retiredInstances![0] = { ...saved.instances[1], password: "" };
  if (reason === "changed-identity") { manager.settings.inventoryAgentId = identity.agentId; manager.settings.identity = { ...identity, agentId: "fresh" }; }
  if (reason === "retired-active") manager.settings.instances.push(saved.instances[2]);
  await new SettingsStore().write(manager.settings); const before = await readFile(path.join(f.root, "state/desktop/settings.json"), "utf8");
  await expect(finish(manager.act("start"))).rejects.toMatchObject({ code: "MAINTENANCE" }); expect(manager.busy).toBe(false); expect(await readFile(path.join(f.root, "state/desktop/settings.json"), "utf8")).toBe(before); expect(f.start).not.toHaveBeenCalled();
}, 15_000);
it("retains a legacy repair through an unknown body response and converges on the next reconnect", async () => {
  await legacyMismatch(); await new SettingsStore().write(manager.settings); await restart();
  const held = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>(); f.fetch.mockImplementationOnce(async () => ({ ok: true, json: () => { entered.resolve(); return held.promise; } }));
  const pending = manager.act("start"); const failed = expect(pending).rejects.toThrow("待核对"); await entered.promise; await vi.advanceTimersByTimeAsync(RETIREMENT_INVENTORY_TIMEOUT_MS + 1); await failed;
  expect(manager.busy).toBe(false); expect(manager.settings.instances).toEqual([saved.instances[0]]); expect(manager.settings.inventoryPending).toBe(true); expect(manager.settings.maintenance).toBeTruthy();
  held.resolve(await post("instance-inventory", {}, identity, false)); await delay(5); expect(manager.settings.instances).toEqual([saved.instances[0]]);
  await finish(manager.act("start")); expect(manager.settings.instances).toContainEqual(saved.instances[1]); expect(manager.settings.retiredInstances).toEqual([saved.instances[2]]); expect(manager.settings.inventoryPending).toBeUndefined(); expect(manager.settings.identity).toEqual(identity);
}, 15_000);
