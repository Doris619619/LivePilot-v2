/** 移除设备释放频道的真实文件事务回归；只使用临时合成身份。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, revokeAgent, renewPairing } from "@/cloud/agents";
import { claimChannel, reconcileRemovedChannelBindings } from "@/cloud/bindings";
import { cloudStore, transaction } from "@/cloud/store";
import { POST } from "@/app/api/agent/[...path]/route";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { Store } from "@/core/storage";
let root: string;
const origin = "https://cloud.example.com";
const old = { agentId: "old_pc", instanceId: "main" };
const current = { agentId: "new_pc", instanceId: "main" };
/** 每次创建隔离云端元数据和本机授权目录。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-channel-release-"));
  for (const [key, value] of Object.entries({ LIVEPILOT_DATA_ROOT: root, LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: origin, LIVEPILOT_ENCRYPTION_KEY: "a".repeat(64), LIVEPILOT_INSTANCES: "main", GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture" })) vi.stubEnv(key, value);
});
/** 只清理经路径核实的测试目录。 */
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-channel-release-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 使用现有协议建立可认证设备，不使用真实身份或 Google 服务。 */
async function enroll(id: string) {
  const token = (id === old.agentId ? "b" : "c").repeat(64); const invite = await createPairing(id, id);
  await pairAgent(id, invite.code, token); const session = await openSession(id, randomUUID(), [{ id: "main", name: "Main" }]);
  return { token, session: session.session };
}
/** 模拟旧版本遗留，或撤销已落盘但释放写入前进程退出。 */
async function legacyRemoval() {
  await enroll(old.agentId); await claimChannel(old, "UC_fixture", true);
  await transaction(cloudStore(), async () => { const registry = (await cloudStore().read<{ agents: { id: string; revoked: boolean }[] }>("agents.json"))!; registry.agents.find(a => a.id === old.agentId)!.revoked = true; await cloudStore().write("agents.json", registry); });
}
it("releases only removed owners and makes historical cleanup idempotent", async () => {
  await legacyRemoval(); await enroll(current.agentId); await claimChannel(current, "UC_active", true);
  // claim 本身也修复历史遗留；再次造入旧记录验证显式部署清理。
  const retained = (await cloudStore().read<unknown[]>("bindings.json"))!;
  await cloudStore().write("bindings.json", [...retained, { ...old, channelId: "UC_fixture", confirmed: true }]);
  expect(await reconcileRemovedChannelBindings()).toBe(1); expect(await reconcileRemovedChannelBindings()).toBe(0);
  expect(await cloudStore().read("bindings.json")).toEqual([{ ...current, channelId: "UC_active", confirmed: true }]);
});
it.each([false, true])("does not resurrect stale ownership when removed identity pairs again, fresh=%s", async fresh => {
  await legacyRemoval();
  if (fresh) { const invite = await createPairing("fresh", "fresh"); await pairAgent("fresh", invite.code, "b".repeat(64), old.agentId); }
  else { const invite = await renewPairing(old.agentId); await pairAgent(old.agentId, invite.code, "b".repeat(64)); }
  expect(await cloudStore().read("bindings.json")).toEqual([]);
});
it("serializes removal with in-flight confirmation and never lets revoked requests reclaim", async () => {
  await enroll(old.agentId); await enroll(current.agentId); await claimChannel(old, "UC_fixture");
  await Promise.allSettled([claimChannel(old, "UC_fixture", true), revokeAgent(old.agentId)]);
  expect(await cloudStore().read("bindings.json")).toEqual([]);
  await expect(claimChannel(old, "UC_fixture", true)).rejects.toMatchObject({ status: 404 });
  await claimChannel(current, "UC_fixture", true); await revokeAgent(old.agentId);
  expect(await cloudStore().read("bindings.json")).toEqual([{ ...current, channelId: "UC_fixture", confirmed: true }]);
});
it("recovers after release persistence fails without restoring the revoked device", async () => {
  await enroll(old.agentId); await claimChannel(old, "UC_fixture", true);
  const write = Store.prototype.write;
  const spy = vi.spyOn(Store.prototype, "write").mockImplementation(async function (this: Store, name: string, value: unknown) { if (name === "bindings.json") throw new Error("disk fixture"); return write.call(this, name, value); });
  await expect(revokeAgent(old.agentId)).rejects.toThrow("disk fixture"); spy.mockRestore();
  await enroll(current.agentId); await claimChannel(current, "UC_fixture", true);
  expect(await cloudStore().read("bindings.json")).toEqual([{ ...current, channelId: "UC_fixture", confirmed: true }]);
});
it("completes old-Agent OAuth through the actual bindings route after removing the former device", async () => {
  await legacyRemoval(); const identity = await enroll(current.agentId);
  // Google 交换用合成响应；设备归属请求经过实际 Transport、路由认证与文件事务。
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(origin + "/api/agent/")) { const headers = new Headers(init?.headers); headers.set("host", new URL(origin).host); return POST(new Request(url, { ...init, headers }), { params: Promise.resolve({ path: ["bindings"] }) }); }
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels?")) return Response.json({ items: [{ id: "UC_fixture", snippet: { title: "Fixture" } }] });
    throw new Error("Unexpected request");
  }));
  const transport = new Transport(origin, current.agentId, identity.token); transport.session = identity.session;
  const app = new Executor(transport).services.get("main")!; const begin = await app.auth.begin("alice");
  await app.auth.finish(begin.cookie, new URL(begin.url).searchParams.get("state")!, "fixture-code", undefined, "alice");
  expect((await app.auth.tokens())?.channelId).toBe("UC_fixture");
  expect(await cloudStore().read("bindings.json")).toEqual([{ ...current, channelId: "UC_fixture", confirmed: true }]);
});
