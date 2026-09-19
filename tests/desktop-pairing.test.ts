/** 桌面配对到真实云端路由的隔离回归；不用模拟成功响应掩盖身份冲突。 */
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { pairDesktop } from "../electron/pairing";
import type { Settings } from "../electron/settings";
import { DESKTOP_ORIGIN } from "@/shared/desktop";
import { POST } from "@/app/api/agent/[...path]/route";
import { createPairing, pairAgent, revokeAgent, openSession, listAgents, agentStore, renewPairing } from "@/cloud/agents";
import { claimChannel } from "@/cloud/bindings";
let root: string;
/** 所有身份、频道和落盘数据均是本测试临时夹具。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-pairing-")); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", DESKTOP_ORIGIN); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); });
/** 只删除创建的独立测试目录，绝不触碰本机配置。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-pairing-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 用真实 HTTP 路由处理桌面请求，包括输入校验、认证及文件事务。 */
const request: typeof fetch = async (url, init) => { const headers = new Headers(init?.headers); headers.set("host", new URL(DESKTOP_ORIGIN).host); return POST(new Request(String(url), { ...init, headers }), { params: Promise.resolve({ path: ["pair"] }) }); };
/** 生产同格式邀请，仅包含合成凭据。 */
async function invite(id: string) { const value = await createPairing(id, "电脑"); return "LN1." + Buffer.from(JSON.stringify({ origin: DESKTOP_ORIGIN, agentId: value.agentId, code: value.code })).toString("base64url"); }
/** 设置中的 OBS、密钥、维护和频道配置必须在恢复期间保持不变。 */
function settings(): Settings { return { dataRoot: root, encryptionKey: "d".repeat(64), instances: [{ id: "main", name: "原 OBS", managed: true, exe: "C:/fixture/obs64.exe", port: 4455, password: "fixture-password", initialized: true }], google: { clientId: "fixture", clientSecret: "fixture" }, maintenance: "e".repeat(64) }; }
/** 登记一台旧电脑，保留实例与身份供移除恢复。 */
async function enrolled(id = "original", token = "b".repeat(64)) { const local = settings(); const p = await createPairing(id, "原电脑"); await pairAgent(id, p.code, token); await openSession(id, randomUUID(), [{ id: "main", name: "原 OBS" }]); local.identity = { agentId: id, origin: DESKTOP_ORIGIN, token }; local.paired = true; return local; }
it("reconnects a removed PC preserving local configuration while released channels can bind elsewhere", async () => {
  const local = await enrolled(); const before = structuredClone(local); await claimChannel({ agentId: "original", instanceId: "main" }, "UC_preserved", true);
  await agentStore("original").write("maintenance.json", { token: local.maintenance }); await revokeAgent("original");
  const save = vi.fn(async () => {}); await pairDesktop(local, await invite("new_invitation"), save, request);
  expect(local).toEqual(before); expect(save).toHaveBeenCalledTimes(2);
  expect((await listAgents()).find(a => a.id === "original")).toMatchObject({ revoked: false, paired: true, instances: [{ id: "main" }] });
  expect((await listAgents()).find(a => a.id === "new_invitation")).toMatchObject({ revoked: true, pairedTo: "original", instances: [] });
  expect(await agentStore("original").read("maintenance.json")).toEqual({ token: local.maintenance });
  await enrolled("other", "c".repeat(64)); await claimChannel({ agentId: "other", instanceId: "main" }, "UC_preserved", true);
  await expect(claimChannel({ agentId: "original", instanceId: "main" }, "UC_preserved", true)).rejects.toMatchObject({ status: 409 });
});
it("retries a lost successful response with the same code and keeps only the original connected device", async () => {
  const local = await enrolled(); await revokeAgent("original"); const code = await invite("new_invitation");
  await expect(pairDesktop(local, code, async () => {}, async (url, init) => { await request(url, init); throw new Error("response lost"); })).rejects.toThrow("结果尚未确认");
  await pairDesktop(local, code, async () => {}, request);
  expect((await listAgents()).filter(a => !a.revoked && a.paired).map(a => a.id)).toEqual(["original"]);
  await revokeAgent("original"); await expect(pairDesktop(local, code, async () => {}, request)).rejects.toThrow("生成新码");
  await pairDesktop(local, await invite("another_invitation"), async () => {}, request); expect(local.identity?.agentId).toBe("original");
});
it("accepts a fresh code after the first pairing response was lost without changing the registered identity", async () => {
  const local = settings(); const first = await invite("first");
  await expect(pairDesktop(local, first, async () => {}, async (url, init) => { await request(url, init); throw new Error("lost"); })).rejects.toThrow();
  const identity = structuredClone(local.identity); expect(local.paired).toBeUndefined();
  await pairDesktop(local, await invite("second"), async () => {}, request); expect(local.identity).toEqual(identity); expect(local.paired).toBe(true);
});
it("can replace an invitation that never reached the server without replacing local keys or OBS", async () => {
  const local = settings(); await expect(pairDesktop(local, await invite("first"), async () => {}, async () => { throw new Error("offline"); })).rejects.toThrow();
  const before = structuredClone(local); await pairDesktop(local, await invite("second"), async () => {}, request);
  expect(local.identity).toEqual({ ...before.identity, agentId: "second" }); expect(local.instances).toEqual(before.instances); expect(local.encryptionKey).toBe(before.encryptionKey);
});
it.each([false, true])("recovers a lost response after replacing a never-used invitation, fresh retry=%s", async fresh => {
  const local = settings(); await expect(pairDesktop(local, await invite("first"), async () => {}, async () => { throw new Error("offline"); })).rejects.toThrow();
  const second = await invite("second");
  await expect(pairDesktop(local, second, async () => {}, async (url, init) => { await request(url, init); throw new Error("lost"); })).rejects.toThrow();
  await pairDesktop(local, fresh ? await invite("third") : second, async () => {}, request);
  expect(local.identity?.agentId).toBe("second"); expect((await listAgents()).filter(a => a.paired && !a.revoked).map(a => a.id)).toEqual(["second"]);
});
it("does not consume a fresh code when the old identity proof is wrong, or accept a code for a different registered device", async () => {
  const local = await enrolled(); await revokeAgent("original"); const code = await invite("fresh");
  const wrong = structuredClone(local); wrong.identity!.token = "c".repeat(64);
  await expect(pairDesktop(wrong, code, async () => {}, request)).rejects.toThrow(); expect((await listAgents()).find(a => a.id === "original")?.revoked).toBe(true);
  await pairDesktop(local, code, async () => {}, request);
  await enrolled("other", "c".repeat(64)); await revokeAgent("other"); const other = await renewPairing("other");
  const foreign = "LN1." + Buffer.from(JSON.stringify({ origin: DESKTOP_ORIGIN, agentId: "other", code: other.code })).toString("base64url");
  await expect(pairDesktop(local, foreign, async () => {}, request)).rejects.toThrow(); expect(local.identity?.agentId).toBe("original");
});
it("allows only one of two existing PCs to redeem the same fresh code", async () => {
  const a = await enrolled(); const b = await enrolled("other", "c".repeat(64)); await revokeAgent("original"); await revokeAgent("other"); const code = await invite("fresh");
  const results = await Promise.allSettled([pairDesktop(a, code, async () => {}, request), pairDesktop(b, code, async () => {}, request)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect((await listAgents()).filter(a => !a.revoked && a.paired)).toHaveLength(1);
});
it("rejects expired codes and preserves local configuration", async () => {
  const local = await enrolled(); const before = structuredClone(local); const code = await invite("fresh"); vi.setSystemTime(Date.now() + 601_000);
  await expect(pairDesktop(local, code, async () => {}, request)).rejects.toThrow("过期"); expect(local).toEqual(before);
});
it("supports legacy same-device responses but refuses an unconfirmed cross-device response", async () => {
  const local = settings(); await pairDesktop(local, await invite("first"), async () => {}, async () => Response.json({ protocol: 1 }));
  const before = structuredClone(local); await expect(pairDesktop(local, await invite("second"), async () => {}, async () => Response.json({ protocol: 1 }))).rejects.toThrow("未确认"); expect(local).toEqual(before);
});
