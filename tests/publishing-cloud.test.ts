/** Cloud 集成覆盖真实权限、文件事务和投递；素材 RPC 用假 Agent 回应。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { randomUUID } from "node:crypto";
const remote = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("@/cloud/tasks", async importOriginal => ({ ...await importOriginal<typeof import("@/cloud/tasks")>(), rpc: remote.scan }));
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, setAgentOwner } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { accessStore, emptyAccess } from "@/server/access";
import { publishingStore, acceptPublishingPrivacy, savePublishingPolicy, savePublishingProfile, previewPublishingBatch, confirmPublishingBatch, publishingView, publishingTick, reportPublishing, chargePublishing, requestPublishingCleanup, completePublishingCleanup, changePublishingJob } from "@/cloud/publishing";
import { defaultPolicy, PRIVACY_VERSION } from "@/shared/publishing";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
let root: string; const alice = { username: "alice", role: "customer" as const }; const admin = { username: "admin", role: "admin" as const };
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "publishing-cloud-")); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T00:00:00Z")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); const access = emptyAccess(); access.users.push(...[alice, admin].map(u => ({ ...u, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }))); await accessStore().write("access.json", access); const p = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", p.code, "b".repeat(64)); const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []); await agentStore("pc").write("capabilities.json", ["publishing-v1"]); await cloudStore().write("bindings.json", [{ agentId: "pc", instanceId: "main", channelId: "channel_one", confirmed: true }]); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid" }); remote.scan.mockResolvedValue({ assets: [fixtureJob().asset], thumbnails: [], channelId: "channel_one", channel: "Test" }); });
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-cloud-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 确认一个私密发布批次；不会发起实际上传或公开。 */
async function batch() { await acceptPublishingPrivacy(alice, PRIVACY_VERSION); const profile = await savePublishingProfile(alice, fixtureJob().profile); return previewPublishingBatch(alice, profile.id, [fixtureJob().asset.id]); }
it.each(["run", "pause", "cancel"] as const)("reconciliation keeps the %s intent and ordinary controls clear only the query marker", async desired => {
  const b = await batch(); const [original] = await confirmPublishingBatch(alice, b.id, false, true);
  await chargePublishing("pc", original.spec.id, randomUUID(), 0, true);
  if (desired !== "run") await changePublishingJob(alice, original.spec.id, desired);
  const before = (await publishingView(alice)).jobs[0]; const query = await changePublishingJob(alice, original.spec.id, "reconcile");
  expect(query.spec).toMatchObject({ desired, revision: before.spec.revision + 1, reconcileRevision: before.spec.revision + 1 }); expect(query.spec.originalPublishAt).toBe(before.spec.originalPublishAt);
  const controlled = await changePublishingJob(alice, original.spec.id, "pause"); expect(controlled.spec.reconcileRevision).toBeUndefined(); expect(controlled.spec.reconcileTotal).toBeUndefined(); expect(controlled.spec.desired).toBe("pause");
});
it("refuses to reconcile a not-yet-uploaded future task without changing its revision or dispatching it", async () => {
  const b = await batch(); const [original] = await confirmPublishingBatch(alice, b.id, false, true);
  const saved = await publishingStore().read<{ jobs: typeof original[] }>("state.json"); saved!.jobs[0].spec.originalPublishAt = "2031-10-01T00:00:00Z"; await publishingStore().write("state.json", saved);
  await expect(changePublishingJob(alice, original.spec.id, "reconcile")).rejects.toMatchObject({ code: "VIDEO_NOT_UPLOADED" });
  expect((await publishingView(alice)).jobs[0].spec).toMatchObject({ revision: 1, desired: "run", originalPublishAt: "2031-10-01T00:00:00Z" }); expect((await publishingView(alice)).jobs[0].spec.reconcileRevision).toBeUndefined();
  await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
});
it("dispatches an admitted read-only request outside the upload window even when complete-upload budget is unavailable", async () => {
  const b = await batch(); const [original] = await confirmPublishingBatch(alice, b.id, false, true);
  await chargePublishing("pc", original.spec.id, randomUUID(), 0, true);
  await savePublishingPolicy(admin, { ...defaultPolicy, enabled: false, privacyContact: "synthetic@example.invalid", uploadsPerDay: 1, otherUnitsPerDay: 1 });
  const saved = await publishingStore().read<{ jobs: typeof original[] }>("state.json"); saved!.jobs[0].spec.originalPublishAt = "2031-10-01T00:00:00Z"; await publishingStore().write("state.json", saved);
  const query = await changePublishingJob(alice, original.spec.id, "reconcile"); expect(query.hadUpload).toBe(true); expect(query.spec.desired).toBe("run"); await publishingTick();
  expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(1); expect((await publishingView(admin)).quota?.reserved).toEqual({ uploads: 0, units: 0 });
  await chargePublishing("pc", original.spec.id, randomUUID(), 1, false); await expect(chargePublishing("pc", original.spec.id, randomUUID(), 1, false)).rejects.toMatchObject({ code: "VIDEO_QUOTA" });
  await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid" }); expect((await publishingView(alice)).jobs[0].spec.reconcileRevision).toBeUndefined();
});
it("accepts a missing-checkpoint read-only report using the fixed prepared package size without relaxing size validation", async () => {
  const b = await batch(); const [original] = await confirmPublishingBatch(alice, b.id, false, true); await chargePublishing("pc", original.spec.id, randomUUID(), 0, true);
  const saved = await publishingStore().read<{ jobs: typeof original[] }>("state.json"); const fixedSize = original.spec.asset.size + 1024;
  saved!.jobs[0].spec.contentPackage = { id: original.spec.asset.id, batchName: "Synthetic Batch", name: "001", version: "c".repeat(64), sourceVideo: original.spec.asset, validationState: "valid", issues: [] };
  saved!.jobs[0].prepared = { version: "d".repeat(64), sha256: "e".repeat(64), size: fixedSize }; await publishingStore().write("state.json", saved);
  const query = await changePublishingJob(alice, original.spec.id, "reconcile"); expect(query.spec.reconcileTotal).toBe(fixedSize);
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store: new PublishingStore(path.join(root, "lost-agent-record")), api: () => api }); await runner.apply(query.spec); await runner.tick();
  const [report] = await runner.reports(); expect(report).toMatchObject({ state: "needs_attention", total: fixedSize, offset: 0 });
  await expect(reportPublishing("pc", [{ ...report, total: original.spec.asset.size }])).rejects.toMatchObject({ code: "REPORT" });
  await reportPublishing("pc", [report]); expect((await publishingView(alice)).jobs[0].observed).toMatchObject({ state: "needs_attention", total: fixedSize }); expect(api.begin).not.toHaveBeenCalled(); expect(api.probe).not.toHaveBeenCalled(); await runner.stop();
});
it("requires privacy consent and current device ownership", async () => { await expect(savePublishingProfile(alice, fixtureJob().profile)).rejects.toMatchObject({ code: "PRIVACY" }); const b = await batch(); await confirmPublishingBatch(alice, b.id, false, true); expect((await publishingView({ username: "bob", role: "customer" })).jobs).toEqual([]); await expect(changePublishingJob({ username: "bob", role: "customer" }, (await publishingView(alice)).jobs[0].spec.id, "cancel")).rejects.toMatchObject({ code: "FORBIDDEN" }); });
it("confirms idempotently with immutable Profile snapshot and explicit per-item copy", async () => { const b = await batch(); const jobs = await confirmPublishingBatch(alice, b.id, false, true, [{ assetId: b.assets[0].id, title: "Manual 🌙", description: "" }]); expect(jobs[0].spec.overrides).toEqual({ title: "Manual 🌙", description: "" }); const again = await confirmPublishingBatch(alice, b.id, false, true); expect(again[0].spec.id).toBe(jobs[0].spec.id); await savePublishingProfile(alice, { ...b.profile, revision: 2, titleTemplate: "Changed" }); expect((await publishingView(alice)).jobs[0].spec.profile.titleTemplate).toBe("{{filenameStem}}"); });
/** 废弃产品开关不阻塞普通客户确认；真实公开由 Agent 的 YouTube 回读判断，仍受滚动窗口和预算约束。 */
it("confirms a public batch without administrator activation and preserves rolling-window dispatch", async () => {
  await acceptPublishingPrivacy(alice, PRIVACY_VERSION); const profile = fixtureJob().profile; profile.privacy = "public"; profile.scheduled = true;
  remote.scan.mockResolvedValue({ assets: Array.from({ length: 100 }, (_, i) => ({ ...fixtureJob().asset, id: i.toString(16).padStart(64, "0"), version: i.toString(16).padStart(64, "0"), filename: `movie${i}.mp4` })), thumbnails: [], channelId: "channel_one" });
  await savePublishingProfile(alice, profile); const b = await previewPublishingBatch(alice, profile.id, (await remote.scan()).assets.map((a: { id: string }) => a.id));
  const saved = await publishingStore().read<{ policy: typeof defaultPolicy }>("state.json"); saved!.policy = { ...saved!.policy, enabled: false, publicVerified: false, privacyContact: "", verificationNote: "" }; await publishingStore().write("state.json", saved);
  await expect(confirmPublishingBatch(alice, b.id, false, false)).rejects.toMatchObject({ code: "CONSENT" });
  const jobs = await confirmPublishingBatch(alice, b.id, false, true); expect(jobs[0].spec.policy).toMatchObject({ enabled: true, publicVerified: true, verificationNote: "" });
  await publishingTick(); const queue = await agentStore("pc").read<{ records: unknown[] }>("tasks.json");
  expect(queue?.records).toHaveLength(jobs.filter(j => Date.parse(j.spec.originalPublishAt!) <= Date.now() + 28 * 86400_000).length);
  const first = jobs[0]; await changePublishingJob(alice, first.spec.id, "reschedule", "2026-10-01T19:30:00Z"); const changed = (await publishingView(alice)).jobs[0];
  expect(changed.initialPublishAt).toBe(first.spec.originalPublishAt); expect(changed.spec.originalPublishAt).toBe("2026-10-01T19:30:00Z");
});

/** 旧 False 存储仅归一兼容位，不触发恢复、改期或新增修订；仍保留人工处理结果。 */
it.each(["paused", "needs_attention"] as const)("normalizes an existing %s task without changing its intent or upload facts", async state => {
  const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true);
  if (state === "paused") await changePublishingJob(alice, job.spec.id, "pause");
  const current = (await publishingView(alice)).jobs[0];
  await reportPublishing("pc", [{ id: job.spec.id, revision: current.spec.revision, sequence: 1, state, videoId: "existing_video", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const saved = await publishingStore().read<{ policy: typeof defaultPolicy; jobs: typeof job[] }>("state.json");
  saved!.policy.enabled = false; saved!.policy.publicVerified = false; saved!.jobs[0].spec.policy.enabled = false; saved!.jobs[0].spec.policy.publicVerified = false; const before = structuredClone(saved!.jobs[0]); await publishingStore().write("state.json", saved);
  const normalized = (await publishingView(alice)).jobs[0]; expect(normalized).toEqual({ ...before, spec: { ...before.spec, policy: { ...before.spec.policy, enabled: true, publicVerified: true } } });
  await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
  expect((await publishingView(alice)).jobs[0]).toEqual(normalized);
});

/** 新策略只接受可验证运行参数，客户不能越权；留空旧验收记录不再成为测试入口门槛。 */
it("saves runtime policy without activation evidence while retaining administrator permissions and limits", async () => {
  const value = { ...defaultPolicy, enabled: false, publicVerified: false, uploadsPerDay: 3, privacyContact: "", verificationNote: "" };
  await expect(savePublishingPolicy(alice, value)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const result = await savePublishingPolicy(admin, value); expect(result).toEqual({ ...value, enabled: true, publicVerified: true });
  await expect(savePublishingPolicy(admin, { ...value, uploadsPerDay: 0 })).rejects.toThrow();
  expect((await publishingView(alice)).policy.uploadsPerDay).toBe(3);
});

/** 保存预算不是恢复授权；异常和失败的任务修订、报告、原策略均保留。 */
it.each(["needs_attention", "failed"] as const)("does not implicitly resume a %s task when runtime policy is saved", async state => {
  const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true);
  await reportPublishing("pc", [{ id: job.spec.id, revision: job.spec.revision, sequence: 1, state, videoId: "existing_video", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const before = (await publishingView(alice)).jobs[0];
  await savePublishingPolicy(admin, { ...defaultPolicy, uploadMbps: 3, publishLeadSeconds: 900 });
  expect((await publishingView(alice)).jobs[0]).toEqual(before);
  await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
  if (state === "needs_attention") {
    const resumed = await changePublishingJob(alice, job.spec.id, "resume");
    expect(resumed.spec).toMatchObject({ revision: before.spec.revision + 1, desired: "run", policy: { uploadMbps: 3, publishLeadSeconds: 900 } });
    expect(resumed.observed).toEqual(before.observed); expect(resumed.spec.originalPublishAt).toBe(before.spec.originalPublishAt);
    await publishingTick(); expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(1);
  }
});

/** 失败是终态，不能受理 Runner 永远不会执行的控制；已有远端关联仍允许只读核对。 */
it("rejects failed-task execution controls while keeping read-only reconciliation available", async () => {
  const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true);
  await reportPublishing("pc", [{ id: job.spec.id, revision: job.spec.revision, sequence: 1, state: "failed", videoId: "existing_video", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const before = (await publishingView(alice)).jobs[0];
  for (const action of ["pause", "resume", "cancel", "reschedule"] as const) await expect(changePublishingJob(alice, job.spec.id, action, "2026-10-04T19:00:00Z")).rejects.toMatchObject({ code: "TERMINAL" });
  expect((await publishingView(alice)).jobs[0]).toEqual(before);
  const query = await changePublishingJob(alice, job.spec.id, "reconcile"); expect(query.spec.reconcileRevision).toBe(before.spec.revision + 1); expect(query.observed?.videoId).toBe("existing_video"); expect(query.spec.desired).toBe(before.spec.desired);
});
it("stores sequence acknowledgements, rejects another agent and admits project budget idempotently", async () => { const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true); const report = { id: job.spec.id, revision: 1, sequence: 2, state: "uploading" as const, offset: 100, total: job.spec.asset.size, updatedAt: Date.now() }; await expect(reportPublishing("other", [report])).rejects.toMatchObject({ code: "REPORT" }); await reportPublishing("pc", [report]); await reportPublishing("pc", [{ ...report, sequence: 1, offset: 0 }]); expect((await publishingView(alice)).jobs[0].observed?.offset).toBe(100); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid", uploadsPerDay: 1, otherUnitsPerDay: 50 }); const receipt = randomUUID(); await chargePublishing("pc", job.spec.id, receipt, 50, true); await chargePublishing("pc", job.spec.id, receipt, 50, true); await expect(chargePublishing("pc", job.spec.id, randomUUID(), 1, false)).rejects.toMatchObject({ code: "VIDEO_QUOTA" }); await expect(chargePublishing("pc", job.spec.id, randomUUID(), 0, true)).rejects.toMatchObject({ code: "VIDEO_QUOTA" }); });
it("removes Cloud publishing data immediately but keeps cleanup pending until correct Agent confirmation", async () => { const b = await batch(); await confirmPublishingBatch(alice, b.id, false, true); const cleanup = await requestPublishingCleanup(alice, "pc", "main"); expect((await publishingView(alice)).jobs).toEqual([]); expect((await publishingView(alice)).cleanups[0].state).toBe("pending"); await expect(savePublishingProfile(alice, fixtureJob().profile)).rejects.toMatchObject({ code: "CLEANUP" }); await expect(completePublishingCleanup("other", cleanup.id)).rejects.toMatchObject({ code: "CLEANUP" }); await completePublishingCleanup("pc", cleanup.id); expect((await publishingView(alice)).cleanups[0].state).toBe("complete"); expect(await cloudStore().read("bindings.json")).toEqual([]); });
it("turns confirmed invalid authorization into a priority cleanup instead of continued uploads", async () => { const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true); await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "needs_attention", offset: 0, total: job.spec.asset.size, updatedAt: Date.now(), authorizationInvalid: true }]); expect((await publishingView(alice)).jobs).toEqual([]); expect((await publishingView(alice)).cleanups[0].state).toBe("pending"); expect(await publishingStore().read("state.json")).toBeTruthy(); });
it("reserves a complete publication before dispatch and clears its structured budget wait after admission", async () => { const b = await batch(); await confirmPublishingBatch(alice, b.id, false, true); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid", otherUnitsPerDay: 53 }); await publishingTick(); expect((await publishingView(alice)).jobs[0]).toMatchObject({ budgetWaiting: true, blockReason: "等待项目发布预算及太平洋时间配额日重置。" }); expect(await agentStore("pc").read("tasks.json")).toBeNull(); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid", otherUnitsPerDay: 54 }); await publishingTick(); expect((await publishingView(admin)).quota?.reserved).toEqual({ uploads: 1, units: 54 }); const job = (await publishingView(alice)).jobs[0]; expect(job.budgetWaiting).toBeUndefined(); expect(job.blockReason).toBeUndefined(); await chargePublishing("pc", job.spec.id, randomUUID(), 0, true); expect((await publishingView(admin)).quota).toMatchObject({ uploads: 1, units: 0, reserved: { uploads: 0, units: 54 } }); await reportPublishing("pc", [{ id: job.spec.id, revision: job.spec.revision, sequence: 1, state: "completed", offset: job.spec.asset.size, total: job.spec.asset.size, updatedAt: Date.now() }]); expect((await publishingView(admin)).quota?.reserved).toEqual({ uploads: 0, units: 0 }); });

it("automatically clears budget waiting when the Pacific quota day resets", async () => {
  const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true);
  await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid", uploadsPerDay: 1, otherUnitsPerDay: 54 });
  await chargePublishing("pc", job.spec.id, randomUUID(), 0, true); await publishingTick();
  expect((await publishingView(alice)).jobs[0].budgetWaiting).toBe(true);
  expect(await agentStore("pc").read("tasks.json")).toBeNull();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []);
  await publishingTick();
  const resumed = (await publishingView(alice)).jobs[0];
  expect(resumed.budgetWaiting).toBeUndefined(); expect(resumed.blockReason).toBeUndefined();
  expect((await publishingView(admin)).quota).toMatchObject({ uploads: 0, units: 0, reserved: { uploads: 1, units: 54 } });
  expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(1);
});
it("hides former-owner plans after device reassignment and blocks their new API admission", async () => { const b = await batch(); const [job] = await confirmPublishingBatch(alice, b.id, false, true); await setAgentOwner("pc", "bob"); const bob = { username: "bob", role: "customer" as const }; await acceptPublishingPrivacy(bob, PRIVACY_VERSION); expect((await publishingView(bob)).jobs).toEqual([]); expect((await publishingView(bob)).profiles).toEqual([]); await expect(chargePublishing("pc", job.spec.id, randomUUID(), 1, false)).rejects.toMatchObject({ code: "FORBIDDEN" }); });
