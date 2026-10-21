/** 桌面库存改名和维护内停用：验证直播保护、退休墓碑与频道释放，不操作真实 OBS。 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { agentStore, createPairing, openSession, pairAgent, heartbeatAgent, listAgents, extendInstances } from "@/cloud/agents";
import { instanceInventory, renameInstance, retireInstance } from "@/cloud/instance-inventory";
import { POST } from "@/app/api/agent/[...path]/route";
import { beginMaintenance } from "@/cloud/maintenance";
import { claimChannel } from "@/cloud/bindings";
import { cloudStore } from "@/cloud/store";
import { initialState } from "@/core/control";
import { Store } from "@/core/storage";
import type { AgentSnapshot } from "@/shared/remote";
let root: string, session: string, boot: string;
const token = "d".repeat(64), instances = [{ id: "main", name: "Main" }, { id: "second", name: "Second" }];
/** 当前设备的每个活跃实例都使用独立的已停止快照。 */
function snapshots(): AgentSnapshot[] { return instances.map(instance => ({ instance, observedAt: Date.now(), dashboard: { state: initialState(), busy: false, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } } })); }
/** 建立合成在线设备和两个已确认频道，绝不连接实际直播服务。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-instance-inventory-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid");
  const pair = await createPairing("pc", "Synthetic"); await pairAgent("pc", pair.code, "b".repeat(64)); boot = randomUUID(); session = (await openSession("pc", boot, instances)).session; await heartbeatAgent("pc", session, snapshots());
  await claimChannel({ agentId: "pc", instanceId: "main" }, "channel_main", true); await claimChannel({ agentId: "pc", instanceId: "second" }, "channel_second", true);
});
/** 清理仅限已验证的临时根目录。 */
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-instance-inventory-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 通过真实 Agent 路由，显式选择是否携带当前会话。 */
async function post(route: string, body: unknown, authenticated = true, includeSession = true) {
  const headers = new Headers({ host: "synthetic.invalid", "content-type": "application/json", "x-livepilot-agent": "pc" });
  if (authenticated) headers.set("authorization", "Bearer " + "b".repeat(64)); if (includeSession) headers.set("x-livepilot-session", session);
  return POST(new Request("https://synthetic.invalid/api/agent/" + route, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ path: [route] }) });
}
it("renames a live instance without maintenance, changing no IDs or bindings", async () => {
  const live = snapshots(); live[1].dashboard.obs.streaming = true; live[1].dashboard.state.phase = "live"; await heartbeatAgent("pc", session, live);
  await renameInstance("pc", "second", "New name"); expect((await listAgents())[0].instances[1]).toEqual({ id: "second", name: "New name" });
  expect((await cloudStore().read<unknown[]>("bindings.json"))?.length).toBe(2);
});
it("retires a safe secondary instance, retains local data/history and never allows ID resurrection", async () => {
  const localData = new Store(path.join(root, "instances", "second")); await localData.write("youtube.enc", "synthetic-encrypted-fixture");
  await beginMaintenance("pc", token); await retireInstance("pc", "second", token); await retireInstance("pc", "second", token);
  expect((await listAgents())[0].instances).toEqual([instances[0]]);
  expect(await cloudStore().read("bindings.json")).toEqual([{ agentId: "pc", instanceId: "main", channelId: "channel_main", confirmed: true }]);
  expect(await localData.read("youtube.enc")).toBe("synthetic-encrypted-fixture");
  expect(await agentStore("pc").read("retired-instances.json")).toEqual([expect.objectContaining({ instance: instances[1], channels: ["channel_second"] })]);
  await expect(extendInstances("pc", instances)).rejects.toMatchObject({ code: "INSTANCE" }); await expect(openSession("pc", boot, instances)).rejects.toMatchObject({ code: "AGENT_CONFIG" });
  await expect(claimChannel({ agentId: "pc", instanceId: "second" }, "channel_second", true)).rejects.toMatchObject({ status: 404 });
  const next = await createPairing("other", "Other"); await pairAgent("other", next.code, "c".repeat(64)); await openSession("other", randomUUID(), [{ id: "main", name: "Other" }]); await claimChannel({ agentId: "other", instanceId: "main" }, "channel_second", true);
});
it("requires maintenance and retains main even with a valid maintenance token", async () => {
  await expect(retireInstance("pc", "second", token)).rejects.toMatchObject({ code: "MAINTENANCE" }); await beginMaintenance("pc", token); await expect(retireInstance("pc", "main", token)).rejects.toMatchObject({ code: "INSTANCE" });
});
it.each(["streaming", "unknown", "youtube", "stale"])("rechecks %s evidence after maintenance was acquired", async mode => {
  await beginMaintenance("pc", token); const current = snapshots();
  if (mode === "streaming") current[1].dashboard.obs.streaming = true;
  if (mode === "unknown") current[1].dashboard.obs.streaming = null;
  if (mode === "youtube") { current[1].dashboard.state.broadcastId = "still_live"; current[1].dashboard.youtube.lifecycle = "live"; }
  if (mode === "stale") current[1].observedAt -= 21000;
  await heartbeatAgent("pc", session, current); await expect(retireInstance("pc", "second", token)).rejects.toMatchObject({ code: "BUSY" }); expect((await listAgents())[0].instances).toHaveLength(2);
});
it("blocks retirement while independent publishing accounts still own the target", async () => {
  await beginMaintenance("pc", token); await cloudStore().write("publishing-accounts.json", { accounts: [{ value: { agentId: "pc", instanceId: "second", status: "connected" } }] });
  await expect(retireInstance("pc", "second", token)).rejects.toMatchObject({ code: "BUSY" });
});
it("keeps a durable tombstone and retries exact release after storage failure", async () => {
  await beginMaintenance("pc", token); const write = Store.prototype.write;
  const spy = vi.spyOn(Store.prototype, "write").mockImplementation(async function (this: Store, name, value) { if (name === "bindings.json") throw new Error("synthetic disk failure"); return write.call(this, name, value); });
  await expect(retireInstance("pc", "second", token)).rejects.toThrow("synthetic disk failure"); spy.mockRestore();
  expect((await listAgents())[0].instances).toHaveLength(1); await retireInstance("pc", "second", token);
  expect(await cloudStore().read("bindings.json")).toEqual([{ agentId: "pc", instanceId: "main", channelId: "channel_main", confirmed: true }]);
});
it("reconciles a lost retirement reply before a restarted Agent opens its session", async () => {
  await beginMaintenance("pc", token); const retired = await post("instance-retire", { id: "second", token }); expect(retired.status).toBe(200); // Caller deliberately loses this reply.
  const read = await post("instance-inventory", {}, true, false); expect(read.status).toBe(200);
  const inventory = await read.json(); expect(inventory).toEqual({ instances: [instances[0]], retiredInstanceIds: ["second"] }); expect(JSON.stringify(inventory)).not.toMatch(/token|path|youtube|secret/i);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 21000);
  session = (await openSession("pc", randomUUID(), inventory.instances)).session;
  expect((await post("instance-retire", { id: "second", token })).status).toBe(200);
  expect(await instanceInventory("pc")).toEqual(inventory); expect((await agentStore("pc").read<unknown[]>("retired-instances.json"))?.length).toBe(1);
});
it("reveals inventory before session only to the device's valid Bearer and never permits pre-session mutations", async () => {
  expect((await post("instance-inventory", {}, false, false)).status).toBe(401);
  expect((await post("instance-rename", { id: "second", name: "No session" }, true, false)).status).toBe(409);
  expect((await post("instance-inventory", {}, true, false)).status).toBe(200);
});
