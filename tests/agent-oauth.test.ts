/** Agent 频道授权与聊天退出验证：先登记频道归属，独立聊天故障不能阻断其他执行器退出。 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { beginRemoteOAuth } from "@/cloud/oauth";
let dir: string;
/** Google 请求在测试中替换为明确的 token/channel 回复。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-oauth-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", dir); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://cloud.example.com"); vi.stubEnv("GOOGLE_CLIENT_ID", "test-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/token") ? { access_token: "TEST_ACCESS", refresh_token: "TEST_REFRESH", expires_in: 3600 } : { items: [{ id: "UC_test", snippet: { title: "Test" } }] })));
});
/** 清理测试文件并恢复网络函数。 */
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-oauth-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
it("claims cloud ownership before persisting local tokens then confirms the binding", async () => {
  const transport = new Transport("https://cloud.example.com", "studio_a", "b".repeat(64)); const executor = new Executor(transport); const app = executor.services.get("main")!;
  const calls: boolean[] = [];
  vi.spyOn(transport, "post").mockImplementation(async (_route, raw) => { const value = raw as { confirm: boolean }; calls.push(value.confirm); expect(!!(await app.auth.tokens())).toBe(value.confirm); return { ok: true } as never; });
  const begin = await app.auth.begin("alice"); const state = new URL(begin.url).searchParams.get("state")!;
  await app.auth.finish(begin.cookie, state, "TEST_CODE", undefined, "alice"); expect(calls).toEqual([false, true]); expect((await app.auth.tokens())?.channelId).toBe("UC_test");
});
it("does not save a channel when the cloud rejects a duplicate binding", async () => {
  const transport = new Transport("https://cloud.example.com", "studio_a", "b".repeat(64)); vi.spyOn(transport, "post").mockRejectedValue(new Error("duplicate"));
  const app = new Executor(transport).services.get("main")!; const begin = await app.auth.begin("alice");
  await expect(app.auth.finish(begin.cookie, new URL(begin.url).searchParams.get("state")!, "CODE", undefined, "alice")).rejects.toThrow(); expect(await app.auth.tokens()).toBeNull();
});
it("explains IP OAuth limitations without calling Google or an Agent", async () => {
  vi.stubEnv("LIVEPILOT_ORIGIN", "https://13.58.47.99");
  await expect(beginRemoteOAuth({ agentId: "studio_a", instanceId: "main" }, "alice")).rejects.toMatchObject({ code: "OAUTH_DOMAIN" }); expect(fetch).not.toHaveBeenCalled();
});
it("finishes chat shutdown even if an instance cannot persist its final checkpoint", async () => {
  const executor = new Executor(new Transport("https://cloud.example.com", "studio_a", "b".repeat(64)));
  const stop = vi.spyOn(executor.services.get("main")!.chat, "stop").mockRejectedValue(new Error("synthetic checkpoint storage failure"));
  await expect(executor.stopChat()).resolves.toBeUndefined(); expect(stop).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});
