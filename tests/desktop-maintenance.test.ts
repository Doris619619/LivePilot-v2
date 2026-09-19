/** 维护与开播竞态、状态未知、身份保留和恢复测试；使用独立合成设备。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, renewPairing, pairAgent, openSession, heartbeatAgent, listAgents, agentStore } from "@/cloud/agents";
import { beginMaintenance, changeMaintenance } from "@/cloud/maintenance";
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
