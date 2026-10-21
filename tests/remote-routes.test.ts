/** 云端 HTTP 边界测试：匿名/错误设备被拒绝，设备目标不隐式回退 main。 */
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { POST as agentPost, GET as agentGet } from "@/app/api/agent/[...path]/route";
import { POST as controlPost } from "@/app/api/control/route";
import { GET as statusGet, POST as statusPost } from "@/app/api/status/route";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent } from "@/cloud/agents";
import { enqueue, pollTasks, reportTasks, terminal, type TaskRecord } from "@/cloud/tasks";
import type { Dashboard } from "@/shared/types";
import { DELETE as removeDevice } from "@/app/api/devices/route";
import { authenticate } from "@/server/access";
import { AppError } from "@/core/errors";
vi.mock("@/server/access", () => ({ authenticate: vi.fn(async () => ({ username: "alice", role: "customer" })), members: async () => [{username:"alice",role:"customer"}] }));
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
  const pairing = await createPairing("studio_a", "Studio A", "alice"); const token = "b".repeat(64);
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
/** 移除要求成员会话、同源写入标记和明确确认，失败不撤销设备。 */
it("protects device removal with browser authentication, CSRF and explicit confirmation", async () => {
  await createPairing("studio_a", "A", "alice");
  const make = (body: unknown = { agentId: "studio_a", confirmed: true }) => new Request("https://cloud.example.com/api/devices", { method: "DELETE", headers: { host: "cloud.example.com", origin: "https://cloud.example.com", "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify(body) });
  const foreign = make(); foreign.headers.set("origin", "https://foreign.example.com"); expect((await removeDevice(foreign)).status).toBe(403);
  expect((await removeDevice(make({ agentId: "studio_a" }))).status).toBe(400);
  vi.mocked(authenticate).mockRejectedValueOnce(new AppError("AUTH", "请先登录。", 401)); expect((await removeDevice(make())).status).toBe(401);
  expect((await removeDevice(make())).status).toBe(200); expect((await removeDevice(make())).status).toBe(200);
});

/** 只构造有权限的合成设备与过期平台证据，状态接口仍经过真实Cloud/RPC和白名单输出。 */
async function refreshDevice(supported: boolean) {
  const pairing = await createPairing("studio_a", "Synthetic", "alice"); await pairAgent("studio_a", pairing.code, "b".repeat(64));
  const session = await openSession("studio_a", randomUUID(), [{ id: "main", name: "Main" }]);
  const dashboard: Dashboard = { busy: false, state: { phase: "live", stage: "Synthetic", broadcastId: "b", updatedAt: new Date().toISOString() }, obs: { ready: true, running: true, streaming: true }, youtube: { connected: true, lifecycle: "live", checkedAt: new Date(Date.now() - 30 * 60_000).toISOString() }, media: { videos: [], music: [] }, configuration: { youtubeRefresh: supported, missing: [], privacy: "private", madeForKids: false } };
  await heartbeatAgent("studio_a", session.session, [{ instance: { id: "main", name: "Main" }, observedAt: Date.now(), dashboard }]);
  return dashboard;
}
/** 人工核对是带CSRF保护的显式操作，不能通过GET/外站请求静默消耗平台预算。 */
function refreshRequest() { return new Request("https://cloud.example.com/api/status?agentId=studio_a&instanceId=main", { method: "POST", headers: { host: "cloud.example.com", origin: "https://cloud.example.com", "x-livepilot": "1" } }); }
it("guards explicit platform checks against anonymous, cross-origin, foreign-owner and unsupported Agents", async () => {
  await refreshDevice(false);
  const cross = refreshRequest(); cross.headers.set("origin", "https://foreign.example.com"); expect((await statusPost(cross)).status).toBe(403);
  vi.mocked(authenticate).mockRejectedValueOnce(new AppError("AUTH", "请先登录。", 401)); expect((await statusPost(refreshRequest())).status).toBe(401);
  vi.mocked(authenticate).mockResolvedValueOnce({ username: "bob", role: "customer" } as Awaited<ReturnType<typeof authenticate>>); expect((await statusPost(refreshRequest())).status).toBe(403);
  expect((await statusPost(refreshRequest())).status).toBe(409);
  expect((await agentStore("studio_a").read<{ records: TaskRecord[] }>("tasks.json"))?.records || []).toHaveLength(0);
});
it("returns the new platform evidence from a real RPC instead of the old heartbeat snapshot", async () => {
  const old = await refreshDevice(true), operation = statusPost(refreshRequest());
  const settled = operation.then(value => ({ value }), error => ({ error }));
  try {
    await vi.waitFor(async () => { expect((await agentStore("studio_a").read<{ records: TaskRecord[] }>("tasks.json"))?.records.some(record => record.kind === "broadcast-read" && record.status === "queued")).toBe(true); }, { interval: 50, timeout: 3000 });
    const [task] = await pollTasks("studio_a"); expect(task.payload.kind).toBe("broadcast-read");
    await reportTasks("studio_a", [{ id: task.id, status: "succeeded", result: { instance: { id: "main", name: "Main" }, observedAt: Date.now(), dashboard: { ...old, youtube: { ...old.youtube, lifecycle: "complete", checkedAt: new Date().toISOString() }, secret: "must-be-stripped" } } }]);
    const response = await operation; expect(response.status).toBe(200); const result = await response.json();
    expect(result.youtube.lifecycle).toBe("complete"); expect(result.youtube.checkedAt).not.toBe(old.youtube.checkedAt);
    expect(JSON.stringify(result)).not.toContain("must-be-stripped");
    const cached = await statusGet(new Request("https://cloud.example.com/api/status?agentId=studio_a&instanceId=main", { headers: { host: "cloud.example.com" } })); expect((await cached.json()).youtube.lifecycle).toBe("live");
  } finally {
    await pollTasks("studio_a");
    const records = (await agentStore("studio_a").read<{ records: TaskRecord[] }>("tasks.json"))?.records || [];
    await reportTasks("studio_a", records.filter(record => !terminal(record.status)).map(record => ({ id: record.id, status: "failed", error: "Synthetic fixture cancelled", httpStatus: 409 })));
    await settled;
  }
}, 20_000);

/** Agent核对也不能为其他实例作证，或由Cloud把过期采样重新盖上当前时间。 */
it.each(["wrong-instance", "expired", "superseded"])("rejects %s platform RPC evidence", async mode => {
  const dashboard = await refreshDevice(true), operation = statusPost(refreshRequest());
  const settled = operation.then(value => ({ value }), error => ({ error }));
  try {
    await vi.waitFor(async () => { expect((await agentStore("studio_a").read<{ records: TaskRecord[] }>("tasks.json"))?.records.some(record => record.kind === "broadcast-read" && record.status === "queued")).toBe(true); }, { interval: 50, timeout: 3000 });
    const [task] = await pollTasks("studio_a");
    const observedAt = Date.now() - (mode === "superseded" ? 100 : 30_000);
    if (mode === "superseded") await enqueue({ agentId: "studio_a", instanceId: "main" }, "alice", { kind: "control", input: { action: "stop" } });
    const reporting = reportTasks("studio_a", [{ id: task.id, status: "succeeded", result: { instance: { id: mode === "wrong-instance" ? "other" : "main", name: "Synthetic" }, dashboard, observedAt } }]);
    if (mode === "wrong-instance") { await expect(reporting).rejects.toMatchObject({ code: "INSTANCE" }); await reportTasks("studio_a", [{ id: task.id, status: "failed", error: "Synthetic mismatched target", httpStatus: 409 }]); }
    else await reporting;
    expect((await operation).status).toBe(409);
  } finally {
    await pollTasks("studio_a");
    const records = (await agentStore("studio_a").read<{ records: TaskRecord[] }>("tasks.json"))?.records || [];
    await reportTasks("studio_a", records.filter(record => !terminal(record.status)).map(record => ({ id: record.id, status: "failed", error: "Synthetic fixture cancelled", httpStatus: 409 })));
    await settled;
  }
}, 20_000);
