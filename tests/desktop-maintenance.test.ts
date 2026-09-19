/** 维护与开播竞态、状态未知、身份保留和恢复测试；使用独立合成设备。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, renewPairing, pairAgent, openSession, heartbeatAgent, listAgents, agentStore } from "@/cloud/agents";
import { beginMaintenance, changeMaintenance } from "@/cloud/maintenance";
import { uploadRecovery } from "@/cloud/upload-recovery";
import { enqueue, pollTasks, reportTasks } from "@/cloud/tasks";
import { initialState } from "@/core/control";
import type { AgentSnapshot } from "@/shared/remote";
let root: string; let session: string; const token = "d".repeat(64); const target = { agentId: "pc_test", instanceId: "main" };
/** 创建在线且确认停止推流的合成设备。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-maint-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); const p = await createPairing("pc_test", "Test"); await pairAgent("pc_test", p.code, "b".repeat(64)); session = (await openSession("pc_test", randomUUID(), [{ id: "main", name: "Main" }])).session; await heartbeatAgent("pc_test", session, [snapshot()]); });
/** 清理范围严格限制为测试临时目录。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-maint-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 真实公开 DTO 的无直播状态。 */
function snapshot(): AgentSnapshot { return { instance: { id: "main", name: "Main" }, observedAt: Date.now(), dashboard: { state: initialState(), busy: false, obs: { ready: true, running: true, streaming: false }, youtube: { connected: false }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } } }; }
it("allows exactly one of simultaneous maintenance and a new start", async () => {
  const results = await Promise.allSettled([beginMaintenance("pc_test", token), enqueue(target, "tester", { kind: "control", input: { action: "start", video: "a.mp4", music: "b.mp3", videoAudio: false } })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
});
it.each([true, null])("refuses active or unknown OBS streaming (%s)", async streaming => { const s = snapshot(); s.dashboard.obs.streaming = streaming; await heartbeatAgent("pc_test", session, [s]); await expect(beginMaintenance("pc_test", token)).rejects.toMatchObject({ status: 409 }); });
it("refuses stale snapshots and missing instances", async () => { const s = snapshot(); s.observedAt -= 21_000; await heartbeatAgent("pc_test", session, [s]); await expect(beginMaintenance("pc_test", token)).rejects.toMatchObject({ status: 409 }); await heartbeatAgent("pc_test", session, []); await expect(beginMaintenance("pc_test", token)).rejects.toMatchObject({ status: 409 }); });
it("retains maintenance across retries, rejects a different owner and permits idempotent release", async () => {
  expect(await beginMaintenance("pc_test", token)).toEqual({ token }); expect(await beginMaintenance("pc_test", token)).toEqual({ token });
  await expect(beginMaintenance("pc_test", "c".repeat(64))).rejects.toMatchObject({ status: 409 });
  await expect(enqueue(target, "tester", { kind: "control", input: { action: "launch" } })).rejects.toMatchObject({ status: 409 });
  await changeMaintenance("pc_test", token); await changeMaintenance("pc_test", token);
  expect((await enqueue(target, "tester", { kind: "control", input: { action: "launch" } })).status).toBe("queued");
});
it("can append or rename OBS but cannot drop existing instances", async () => {
  await beginMaintenance("pc_test", token); await changeMaintenance("pc_test", token, [{ id: "main", name: "New name" }, { id: "obs_second", name: "Second" }]);
  expect((await listAgents())[0].instances.map(i => i.id)).toEqual(["main", "obs_second"]);
  await expect(changeMaintenance("pc_test", token, [{ id: "main", name: "Main" }])).rejects.toMatchObject({ status: 409 });
  await expect(changeMaintenance("pc_test", "e".repeat(64), [{ id: "main", name: "Main" }])).rejects.toMatchObject({ status: 409 });
});
it("blocks maintenance throughout a browser OAuth transaction, then releases on completed authorization", async () => {
  const task = await enqueue(target, "tester", { kind: "oauth-begin" }); await pollTasks("pc_test");
  await reportTasks("pc_test", [{ id: task.id, status: "succeeded", result: { cookie: "f".repeat(64), url: "https://accounts.google.com/test" } }]);
  await expect(beginMaintenance("pc_test", token)).rejects.toMatchObject({ status: 409 });
  const finish = await enqueue(target, "tester", { kind: "oauth-finish", cookie: "f".repeat(64), state: "fixture", code: "fixture" }); await pollTasks("pc_test"); await reportTasks("pc_test", [{ id: finish.id, status: "succeeded", result: { ok: true } }]);
  await expect(beginMaintenance("pc_test", token)).resolves.toEqual({ token });
});
it("does not leak the maintenance credential through device listings", async () => { await beginMaintenance("pc_test", token); expect(JSON.stringify(await listAgents())).not.toContain(token); expect((await agentStore("pc_test").read<{ token: string }>("maintenance.json"))?.token).toBe(token); });
it("renewal invalidates the old invitation without permitting claimed-device takeover", async () => {
  const old = await createPairing("new_pc", "New"); const next = await renewPairing("new_pc");
  await expect(pairAgent("new_pc", old.code, "e".repeat(64))).rejects.toMatchObject({ status: 401 }); await pairAgent("new_pc", next.code, "e".repeat(64)); await expect(renewPairing("new_pc")).rejects.toMatchObject({ status: 409 });
});

/** 统一生成合法的旧 Agent 上传状态，不引入新协议字段。 */
function uploadResult(id: string, status: "uploading" | "complete" = "uploading") {
  return { id, instanceId: "main", kind: "videos", filename: "fixture.mp4", size: 4, received: status === "complete" ? 4 : 0, chunkSize: 8388608, fingerprint: "a".repeat(64), status, expiresAt: Date.now() + 7 * 86400000 };
}
/** 创建已投递但尚未回报的合成上传。 */
async function pendingUpload() {
  const uploadId = randomUUID();
  const task = await enqueue(target, "tester", { kind: "upload-create", uploadId, input: { kind: "videos", filename: "fixture.mp4", size: 4, fingerprint: "a".repeat(64) } });
  await pollTasks(target.agentId); return { task, uploadId };
}
it("reconciles failed creation with confirmed absence instead of waiting seven days", async () => {
  const { task, uploadId } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "failed", httpStatus: 507, error: "disk full" }]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toMatchObject({ status: 409 });
  const [query] = await pollTasks(target.agentId); expect(query.payload).toEqual({ kind: "upload-status", uploadId });
  await reportTasks(target.agentId, [{ id: query.id, status: "failed", httpStatus: 404, error: "missing" }]);
  await expect(beginMaintenance(target.agentId, token)).resolves.toEqual({ token });
});
it("keeps a created upload when the create reply failed after persistence", async () => {
  const { task, uploadId } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "failed", httpStatus: 500 }]);
  const [query] = await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: query.id, status: "succeeded", result: uploadResult(uploadId) }]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
  expect(await uploadRecovery(target, "tester")).toMatchObject([{ id: uploadId, filename: "fixture.mp4" }]);
  expect(await uploadRecovery(target, "another-account")).toEqual([]);
});
it("recovers creation with a lost browser response and permits confirmed cancellation", async () => {
  const { task, uploadId } = await pendingUpload();
  expect(await uploadRecovery(target, "tester")).toMatchObject([{ id: uploadId }]);
  await expect(enqueue(target, "tester", { kind: "upload-cancel", uploadId })).rejects.toMatchObject({ code: "BUSY" });
  await reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(uploadId) }]);
  const cancel = await enqueue(target, "tester", { kind: "upload-cancel", uploadId }); await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: cancel.id, status: "succeeded", result: { ok: true } }]);
  expect(await uploadRecovery(target, "tester")).toEqual([]);
  await expect(beginMaintenance(target.agentId, token)).resolves.toEqual({ token });
});
it("does not treat an uncertain upload as finished after seven days", async () => {
  const { task } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "accepted" }]);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 8 * 86400000);
  await heartbeatAgent(target.agentId, session, [snapshot()]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
});
it("clears activity from an authoritative complete status, including an older Agent", async () => {
  const { task, uploadId } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(uploadId) }]);
  const query = await enqueue(target, "tester", { kind: "upload-status", uploadId }); await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: query.id, status: "succeeded", result: uploadResult(uploadId, "complete") }]);
  await expect(beginMaintenance(target.agentId, token)).resolves.toEqual({ token });
});
it("rejects upload status for a different upload ID", async () => {
  const { task } = await pendingUpload();
  await expect(reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(randomUUID()) }])).rejects.toMatchObject({ status: 403 });
});
it("does not clear a legacy orphan based on an unrelated target reporting absence", async () => {
  const uploadId = randomUUID(); await agentStore(target.agentId).write("maintenance.json", { activities: { ["upload:" + uploadId]: 1 } });
  expect(await uploadRecovery(target, "tester")).toMatchObject([{ id: uploadId }]);
  const query = await enqueue(target, "tester", { kind: "upload-status", uploadId }); await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: query.id, status: "failed", httpStatus: 404 }]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
});

it("does not trust a late missing-status response that began during creation", async () => {
  const { task, uploadId } = await pendingUpload();
  const query = await enqueue(target, "tester", { kind: "upload-status", uploadId }); await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(uploadId) }]);
  await reportTasks(target.agentId, [{ id: query.id, status: "failed", httpStatus: 404 }]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
});
it("does not trust a status queued before a newer upload mutation", async () => {
  const { task, uploadId } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(uploadId) }]);
  const query = await enqueue(target, "tester", { kind: "upload-status", uploadId });
  const chunk = await enqueue(target, "tester", { kind: "upload-chunk", uploadId, slot: randomUUID(), offset: 0, hash: "a".repeat(64), size: 4 });
  await pollTasks(target.agentId);
  await reportTasks(target.agentId, [{ id: chunk.id, status: "succeeded", result: uploadResult(uploadId) }, { id: query.id, status: "failed", httpStatus: 404 }]);
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
});

it("does not allow another actor to manufacture absence for an existing upload", async () => {
  const { task, uploadId } = await pendingUpload();
  await reportTasks(target.agentId, [{ id: task.id, status: "succeeded", result: uploadResult(uploadId) }]);
  await expect(enqueue(target, "another-account", { kind: "upload-status", uploadId })).rejects.toMatchObject({ status: 404 });
  await expect(enqueue(target, "another-account", { kind: "upload-create", uploadId, input: { kind: "videos", filename: "fixture.mp4", size: 4, fingerprint: "a".repeat(64) } })).rejects.toMatchObject({ status: 404 });
  await expect(beginMaintenance(target.agentId, token)).rejects.toThrow("上传");
});
