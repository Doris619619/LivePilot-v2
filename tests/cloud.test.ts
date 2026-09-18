/** 云端持久派发和多电脑隔离测试；不调用真实 OBS/Google/AWS。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, heartbeatAgent, authenticateAgent, revokeAgent, agentStore } from "@/cloud/agents";
import { enqueue, pollTasks, readTask, reportTasks } from "@/cloud/tasks";
import { claimChannel } from "@/cloud/bindings";
import { remoteDashboard, target } from "@/server/remote";
import { initialState } from "@/core/control";
import { dashboardSchema } from "@/shared/remote-validation";
import { taskSchema, type AgentSnapshot } from "@/shared/remote";
let dir: string;
const destination = { agentId: "studio_a", instanceId: "main" };
/** 每个测试使用独立数据和密钥，绝不触碰真实授权。 */
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-cloud-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", dir); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_MODE", "cloud"); });
/** 只清理经过验证的测试临时目录。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-cloud-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 用真实设备注册/会话流程建立测试设备。 */
async function connect(id: string) {
  const paired = await createPairing(id, id); const token = (id === "studio_a" ? "b" : "c").repeat(64);
  await pairAgent(id, paired.code, token); const session = await openSession(id, randomUUID(), [{ id: "main", name: "主 OBS" }]);
  await heartbeatAgent(id, session.session, []); return { token, ...session };
}
/** 构造安全公开快照，不含秘密。 */
function snapshot(): AgentSnapshot { return { instance: { id: "main", name: "主 OBS" }, observedAt: Date.now(), dashboard: { state: initialState(), busy: false, obs: { ready: true, running: true, streaming: true }, youtube: { connected: true, lifecycle: "live", ingest: "active" }, media: { videos: ["video.mp4"], music: ["music.mp3"] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } } }; }
it("requires both target identities and isolates identical main IDs", async () => {
  await connect("studio_a"); await connect("studio_b"); expect(() => target({ instanceId: "main" })).toThrow();
  const a = await enqueue(destination, "alice", { kind: "control", input: { action: "stop" } });
  const b = await enqueue({ agentId: "studio_b", instanceId: "main" }, "bob", { kind: "control", input: { action: "launch" } });
  expect((await pollTasks("studio_a")).map(t => t.id)).toEqual([a.id]); expect((await pollTasks("studio_b")).map(t => t.id)).toEqual([b.id]);
  expect(await readTask("studio_a", b.id)).toBeUndefined();
});
it("deduplicates IDs and locks conflicting operations until the actual result", async () => {
  await connect("studio_a"); const id = randomUUID(); const payload = { kind: "control" as const, input: { action: "stop" as const } };
  await enqueue(destination, "alice", payload, id); expect((await enqueue(destination, "alice", payload, id)).id).toBe(id);
  await expect(enqueue(destination, "bob", payload, id)).rejects.toMatchObject({ status: 409 });
  await expect(enqueue(destination, "bob", payload)).rejects.toMatchObject({ status: 409 });
  await pollTasks("studio_a"); await reportTasks("studio_a", [{ id, status: "running" }]);
  await reportTasks("studio_a", [{ id, status: "succeeded", result: { id, action: "stop", actor: "alice", status: "succeeded", updatedAt: new Date().toISOString() } }]);
  await reportTasks("studio_a", [{ id, status: "accepted" }]); expect((await readTask("studio_a", id))?.status).toBe("succeeded");
  expect((await enqueue(destination, "bob", payload)).status).toBe("queued");
});
it("expires unsent requests but retains an uncertain delivered operation", async () => {
  await connect("studio_a"); const sent = await enqueue(destination, "alice", { kind: "control", input: { action: "stop" } }); await pollTasks("studio_a");
  vi.setSystemTime(Date.now() + 61_000); expect((await readTask("studio_a", sent.id))?.status).toBe("uncertain");
  const queue = await agentStore("studio_a").read<{ records: { status: string }[] }>("tasks.json"); expect(queue!.records[0].status).toBe("delivering");
  // 重启没有清空持久记录，重新读取仍保留待核对的设备投递。
  expect((await pollTasks("studio_a"))[0].id).toBe(sent.id);
  await reportTasks("studio_a", [{ id: sent.id, status: "expired" }]); expect((await readTask("studio_a", sent.id))?.status).toBe("expired");
});
it("marks offline OBS unknown and rejects new work while returning existing receipts", async () => {
  const a = await connect("studio_a"); await heartbeatAgent("studio_a", a.session, [snapshot()]);
  const id = randomUUID(); const payload = { kind: "control" as const, input: { action: "stop" as const } }; await enqueue(destination, "alice", payload, id);
  vi.setSystemTime(Date.now() + 21_000); const dashboard = await remoteDashboard(destination);
  expect(dashboard.device?.online).toBe(false); expect(dashboard.obs.streaming).toBeNull();
  expect((await enqueue(destination, "alice", payload, id)).id).toBe(id);
  await expect(enqueue(destination, "alice", { kind: "upload-status", uploadId: randomUUID() })).rejects.toMatchObject({ status: 503 });
});
it("revokes device credentials and refuses copied active sessions", async () => {
  const a = await connect("studio_a"); const request = new Request("https://test/api/agent/poll", { headers: { authorization: "Bearer " + a.token, "x-livepilot-agent": "studio_a", "x-livepilot-session": a.session } });
  expect((await authenticateAgent(request)).id).toBe("studio_a");
  await expect(openSession("studio_a", randomUUID(), [{ id: "main", name: "主 OBS" }])).rejects.toMatchObject({ status: 409 });
  await revokeAgent("studio_a"); await expect(authenticateAgent(request)).rejects.toMatchObject({ status: 401 });
});
it("reserves global channel ownership permanently even if the owning device goes offline", async () => {
  await connect("studio_a"); await connect("studio_b"); await claimChannel(destination, "UC_fixture", false);
  await expect(claimChannel({ agentId: "studio_b", instanceId: "main" }, "UC_fixture", true)).rejects.toMatchObject({ status: 409 });
  await claimChannel(destination, "UC_fixture", true); await revokeAgent("studio_a");
  await expect(claimChannel({ agentId: "studio_b", instanceId: "main" }, "UC_fixture")).rejects.toMatchObject({ status: 409 });
});
it("keeps OAuth codes encrypted and limits pair retries to the originally enrolled key", async () => {
  const pairing = await createPairing("studio_a", "A"); await pairAgent("studio_a", pairing.code, "b".repeat(64));
  await pairAgent("studio_a", pairing.code, "b".repeat(64)); await expect(pairAgent("studio_a", pairing.code, "c".repeat(64))).rejects.toMatchObject({ status: 401 });
  const session = await openSession("studio_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("studio_a", session.session, []);
  await enqueue(destination, "alice", { kind: "oauth-finish", cookie: "d".repeat(64), state: "main.fixture", code: "SENSITIVE_TEST_CODE" });
  expect(await readFile(path.join(agentStore("studio_a").dir, "tasks.json"), "utf8")).not.toContain("SENSITIVE_TEST_CODE");
});

/** 短、大写成员名必须同时通过云端派发与 Agent 协议校验。 */
it("delivers built-in member actions through the Agent task schema", async () => {
  await connect("studio_a");
  await enqueue(destination, "Do", { kind: "control", input: { action: "launch" } });
  const tasks = await pollTasks("studio_a");
  expect(tasks).toHaveLength(1);
  expect(taskSchema.parse(tasks[0]).actor).toBe("Do");
});

/** 频道公开身份贯穿 Agent 白名单与云端快照；旧 Agent 未提供 ID 仍兼容。 */
it("preserves public channel identity while stripping credentials from snapshots", async () => {
  const session = await connect("studio_a");
  const value = snapshot();
  value.dashboard = dashboardSchema.parse({ ...value.dashboard, youtube: { connected: true, channel: "绑定频道", channelId: "UC_bound", accessToken: "must-not-leak" } });
  await heartbeatAgent("studio_a", session.session, [value]);
  const result = await remoteDashboard(destination);
  expect(result.youtube).toEqual({ connected: true, channel: "绑定频道", channelId: "UC_bound" });
  expect(dashboardSchema.parse(snapshot().dashboard).youtube.channelId).toBeUndefined();
});
