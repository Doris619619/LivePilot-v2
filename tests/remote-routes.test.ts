/** 云端 HTTP 边界测试：匿名/错误设备被拒绝，设备目标不隐式回退 main。 */
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { POST as agentPost, GET as agentGet } from "@/app/api/agent/[...path]/route";
import { POST as controlPost } from "@/app/api/control/route";
import { GET as statusGet } from "@/app/api/status/route";
import { createPairing } from "@/cloud/agents";
vi.mock("@/server/access", () => ({ authenticate: vi.fn(async () => ({ username: "alice" })) }));
let dir: string;
/** 创建隔离云端环境，不读取真实 .env.local。 */
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-api-")); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://cloud.example.com"); vi.stubEnv("LIVEPILOT_DATA_ROOT", dir); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); });
/** 仅清理本测试目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-api-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 为 Next catch-all 路由提供真实异步 params。 */
function context(route: string) { return { params: Promise.resolve({ path: route.split("/") }) }; }
/** 模拟 Agent 使用专用 header，而不是浏览器 Cookie。 */
function request(route: string, data: unknown, token?: string, session?: string) { return new Request("https://cloud.example.com/api/agent/" + route, { method: "POST", headers: { host: "cloud.example.com", "content-type": "application/json", ...(token ? { authorization: "Bearer " + token, "x-livepilot-agent": "studio_a" } : {}), ...(session ? { "x-livepilot-session": session } : {}) }, body: JSON.stringify(data) }); }
it("pairs, opens a session, accepts a command and returns only that device's task", async () => {
  const pairing = await createPairing("studio_a", "Studio A"); const token = "b".repeat(64);
  expect((await agentPost(request("pair", { protocol: 1, agentId: "studio_a", code: pairing.code, token }), context("pair"))).status).toBe(200);
  const connected = await agentPost(request("session", { protocol: 1, bootId: randomUUID(), instances: [{ id: "main", name: "Main" }] }, token), context("session"));
  const { session } = await connected.json();
  expect((await agentPost(request("heartbeat", { protocol: 1, snapshots: [], reports: [] }, token, session), context("heartbeat"))).status).toBe(200);
  const control = new Request("https://cloud.example.com/api/control", { method: "POST", headers: { host: "cloud.example.com", origin: "https://cloud.example.com", "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ agentId: "studio_a", instanceId: "main", requestId: randomUUID(), action: "launch" }) });
  expect((await controlPost(control)).status).toBe(202);
  const poll = new Request("https://cloud.example.com/api/agent/poll", { headers: { host: "cloud.example.com", authorization: "Bearer " + token, "x-livepilot-agent": "studio_a", "x-livepilot-session": session } });
  const response = await agentGet(poll, context("poll")); const body = await response.json(); expect(body.tasks).toHaveLength(1); expect(body.tasks[0].agentId).toBe("studio_a");
  expect(JSON.stringify(body)).not.toContain(token);
});
it("does not accept browser-origin Agent requests or implicit cloud targets", async () => {
  const bad = request("session", {}); bad.headers.set("origin", "https://cloud.example.com"); expect((await agentPost(bad, context("session"))).status).toBe(403);
  const response = await statusGet(new Request("https://cloud.example.com/api/status?instanceId=main", { headers: { host: "cloud.example.com" } })); expect(response.status).toBe(400);
  expect((await agentPost(request("session", {}), context("session"))).status).not.toBe(200);
});
