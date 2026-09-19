/** 桌面初始化接口必须沿用现有 Agent 的 Host、Bearer 和有效会话认证。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, revokeAgent } from "@/cloud/agents";
import { POST } from "@/app/api/agent/[...path]/route";
let root: string;
/** 只用临时文件与虚构 Google 凭据。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-auth-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://cloud.example.com"); vi.stubEnv("GOOGLE_CLIENT_ID", "fixture"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret"); });
/** 验证目录边界后移除测试数据。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-auth-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 模拟只来自本机进程的设备请求，不使用浏览器 Cookie 认证。 */
async function bootstrap(headers: Record<string, string>) { return POST(new Request("https://cloud.example.com/api/agent/bootstrap", { method: "POST", headers: { host: "cloud.example.com", "content-type": "application/json", ...headers }, body: "{}" }), { params: Promise.resolve({ path: ["bootstrap"] }) }); }
it("requires enrolled token AND a valid device session, rejects browser origin and revoked devices", async () => {
  const invite = await createPairing("pc_test", "Test"); const token = "b".repeat(64); await pairAgent("pc_test", invite.code, token);
  const headers = { authorization: "Bearer " + token, "x-livepilot-agent": "pc_test" };
  expect((await bootstrap({})).status).not.toBe(200);
  expect((await bootstrap(headers)).status).toBe(409);
  const { session } = await openSession("pc_test", randomUUID(), [{ id: "main", name: "Main" }]); const authenticated = { ...headers, "x-livepilot-session": session };
  expect((await bootstrap({ ...authenticated, origin: "https://cloud.example.com" })).status).toBe(403);
  expect((await bootstrap({ ...authenticated, host: "evil.example" })).status).toBe(403);
  const result = await bootstrap(authenticated); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store"); expect(await result.json()).toEqual({ clientId: "fixture", clientSecret: "fixture-secret" });
  await revokeAgent("pc_test"); expect((await bootstrap(authenticated)).status).toBe(401);
});
