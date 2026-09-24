/** 删除与重配的真实云端事务回归，所有凭据和磁盘数据均为临时夹具。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, deleteAgent, revokeAgent, inspectBinding, authenticateAgent, listAgents, openSession, heartbeatAgent } from "@/cloud/agents";
import { remoteInstances } from "@/server/remote";
import { POST } from "@/app/api/desktop/binding/route";
import { DesktopAuth } from "../electron/auth";
import { DesktopAccess } from "../electron/desktop-access";
import { Manager } from "../electron/manager";
import { Activity } from "../electron/activity";
import { DESKTOP_ORIGIN } from "@/shared/desktop";
import type { Settings } from "../electron/settings";
import { pairDesktop } from "../electron/pairing";
import { POST as pairRoute } from "@/app/api/agent/[...path]/route";
vi.mock("electron", () => ({ app: { getVersion: () => "test", getLoginItemSettings: () => ({ openAtLogin: false }) }, net: {}, session: {}, dialog: {}, shell: {} }));
vi.mock("../electron/updates", () => ({ Updates: class {} }));
vi.mock("@/server/access", () => ({ authenticate: async () => ({ username: "Liang", role: "customer" }) }));
let root: string;
const token = "b".repeat(64);
/** 初始化独立云端配置，禁止读写生产目录。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-binding-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", DESKTOP_ORIGIN); });
/** 只清理当前用例生成的临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-binding-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 本机配置保留合成 OBS 和密钥；只替代进程和落盘副作用。 */
async function fixture(owner = "Liang") {
  const invite = await createPairing("original", "电脑", owner); await pairAgent("original", invite.code, token);
  const settings: Settings = { dataRoot: root, encryptionKey: "d".repeat(64), paired: true, identity: { agentId: "original", origin: DESKTOP_ORIGIN, token }, instances: [{ id: "main", name: "OBS", exe: "fixture", port: 4455, password: "fixture", initialized: true, managed: true }, { id: "obs_second", name: "OBS 2", exe: "fixture2", port: 4456, password: "fixture2", initialized: true, managed: true }], maintenance: "e".repeat(64) };
  const stop = vi.fn().mockResolvedValue(undefined); const write = vi.fn().mockResolvedValue(undefined);
  const manager = Object.assign(Object.create(Manager.prototype), { settings, busy: false, agent: { stop, snapshots: [], problems: [], lastHeartbeat: 0 }, store: { write }, activity: new Activity(), discovery: {}, updates: { state: {} }, checks: [] }) as Manager;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ token: "a".repeat(64), user: { username: "Liang", role: "customer" }, expires: Date.now() + 60000 });
    return POST(new Request(url, { ...init, headers: { ...init?.headers, host: new URL(DESKTOP_ORIGIN).host } }));
  });
  const auth = new DesktopAuth(request); await auth.login("Liang", "fixture");
  return { manager, auth, access: new DesktopAccess(auth, manager), stop, write, request };
}
it("cloud deletion clears both ends and permits a fresh identity without changing OBS or keys", async () => {
  const f = await fixture(); const before = structuredClone(f.manager.settings);
  await deleteAgent("original"); const result = await f.access.read(); expect(result.ok).toBe(true);
  expect(f.manager.settings).toMatchObject({ paired: false, instances: before.instances, encryptionKey: before.encryptionKey }); expect(f.manager.settings.identity).toBeUndefined(); expect(f.manager.settings.maintenance).toBeUndefined(); expect(f.stop).toHaveBeenCalledOnce();
  expect((await remoteInstances({ username: "Liang", role: "customer" })).agents).toEqual([]);
  const next = await createPairing("fresh", "新电脑", "Liang");
  const invitation = "LN1." + Buffer.from(JSON.stringify({ origin: DESKTOP_ORIGIN, agentId: next.agentId, code: next.code })).toString("base64url");
  await pairDesktop(f.manager.settings, invitation, async () => {}, (url, init) => pairRoute(new Request(url, { ...init, headers: { ...init.headers, host: new URL(DESKTOP_ORIGIN).host } }), { params: Promise.resolve({ path: ["pair"] }) }));
  expect(f.manager.settings.identity?.agentId).toBe("fresh"); expect(f.manager.settings.identity?.token).not.toBe(token); expect(f.manager.settings.instances).toEqual(before.instances);
  const descriptors = f.manager.settings.instances.map(({ id, name }) => ({ id, name }));
  const session = await openSession("fresh", "11111111-1111-4111-8111-111111111111", descriptors);
  await heartbeatAgent("fresh", session.session, []);
  const online = await remoteInstances({ username: "Liang", role: "customer" });
  expect(online.agents).toHaveLength(1); expect(online.agents[0].online).toBe(true); expect(online.instances.map(i => i.id)).toEqual(["main", "obs_second"]);
  await expect(authenticateAgent(new Request(DESKTOP_ORIGIN, { headers: { authorization: "Bearer " + token, "x-livepilot-agent": "original" } }), false)).rejects.toMatchObject({ status: 401 });
});
it("automatically clears legacy revoked devices without requiring customer assignment", async () => { const f = await fixture(""); await revokeAgent("original"); expect((await f.access.read()).ok).toBe(true); expect(f.manager.settings.paired).toBe(false); });
it("desktop deletion is idempotent and disappears from cloud lists", async () => { const f = await fixture(); await f.access.remove(); await f.access.remove(); expect(f.manager.settings.paired).toBe(false); expect((await listAgents())[0].revoked).toBe(true); expect((await remoteInstances()).agents).toEqual([]); });
it("keeps foreign customer data hidden and reports permissions instead of a network error", async () => { const f = await fixture("Other"); const result = await f.access.read(); expect(result).toMatchObject({ ok: false, problem: { code: "FORBIDDEN", source: "desktop" } }); expect(f.stop).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); });
it.each([403, 429, 500])("preserves binding and login on failed inspection %s", async status => { const f = await fixture(); f.request.mockResolvedValue(new Response("private upstream", { status })); const result = await f.access.read(); expect(result.ok).toBe(false); expect(f.auth.session().authenticated).toBe(true); expect(f.manager.settings.paired).toBe(true); expect(f.stop).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("private upstream"); });
it("does not interpret network failure or invalid proof as deletion", async () => { const f = await fixture(); f.request.mockRejectedValue(new Error("secret")); expect(await f.access.read()).toMatchObject({ ok: false, problem: { code: "CLOUD_NETWORK" } }); expect(f.write).not.toHaveBeenCalled(); await deleteAgent("original"); await expect(inspectBinding("original", "c".repeat(64), "Liang")).rejects.toMatchObject({ code: "PAIR_IDENTITY" }); });
it("retains old settings on drain or persistence failure and recovers on retry", async () => { const f = await fixture(); const before = structuredClone(f.manager.settings); await deleteAgent("original"); f.stop.mockRejectedValueOnce(new Error("drain")); expect((await f.access.read()).ok).toBe(false); expect(f.manager.settings).toEqual(before); f.write.mockRejectedValueOnce(Object.assign(new Error("disk"), { code: "ENOSPC" })); expect(await f.access.read()).toMatchObject({ ok: false, problem: { code: "STORAGE_SPACE" } }); expect(f.manager.settings).toEqual(before); expect((await f.access.read()).ok).toBe(true); });
it("does not revive deleted identities through old pairing recovery", async () => { await fixture(); await deleteAgent("original"); const invitation = await createPairing("new", "电脑", "Liang"); await expect(pairAgent("new", invitation.code, token, "original", "Liang")).rejects.toMatchObject({ code: "AGENT_DELETED" }); });
it("rechecks owner inside deletion transaction", async () => { await fixture("Other"); await expect(deleteAgent("original", "Liang", token)).rejects.toMatchObject({ code: "FORBIDDEN" }); expect((await listAgents())[0].revoked).toBe(false); });
it("does not detach while another desktop operation is running", async () => { const f = await fixture(); await deleteAgent("original"); f.manager.busy = true; expect(await f.access.read()).toMatchObject({ ok: false, problem: { code: "DESKTOP_BUSY" } }); expect(f.stop).not.toHaveBeenCalled(); });

it("retains a consumed invitation only until its active target is deleted", async () => {
  await fixture(); const invite = await createPairing("invitation", "电脑", "Liang"); await pairAgent("invitation", invite.code, token, "original", "Liang");
  expect((await remoteInstances()).agents.find(a => a.id === "invitation")?.pairedTo).toBe("original");
  await deleteAgent("original"); expect((await remoteInstances()).agents).toEqual([]);
});
