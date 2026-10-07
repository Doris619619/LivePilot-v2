/** 批次删除的 Cloud/API 回归：真实文件事务和权限，扫描及远端状态均为合成输入。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const remote = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/cloud/tasks", async importOriginal => ({ ...await importOriginal<typeof import("@/cloud/tasks")>(), rpc: remote.rpc }));
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, setAgentOwner } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { accessStore, digest, emptyAccess } from "@/server/access";
import { acceptPublishingPrivacy, archivePublishingPlan, changePublishingJob, chargePublishing, confirmPublishingBatch, confirmPublishingPlan, confirmPublishingReschedule, previewPublishingBatch, previewPublishingPlan, previewPublishingReschedule, publishingStore, publishingTick, publishingView, removePublishingBatch, reportPublishing, savePublishingPolicy, savePublishingProfile, updatePublishingPlan } from "@/cloud/publishing";
import { createPublishingAccount, claimPublishingAccount } from "@/cloud/publishing-accounts";
import { finishBatchRemovals, safeRemovalJob, type BatchRemovalRecord } from "@/cloud/publishing-removal";
import { POST } from "@/app/api/publishing/route";
import { defaultPolicy, PRIVACY_VERSION, type PackageBatch, type PublishingPlan, type PublishingPlanRule, type PublishingReport, type VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";
const alice = { username: "alice", role: "customer" as const }; const admin = { username: "admin", role: "admin" as const };
const rule: PublishingPlanRule = { timezone: "UTC", startDate: "2026-10-01", weeklySlots: [{ weekday: 4, time: "20:00" }], preuploadDays: 28 };
type Saved = { jobs: VideoJob[]; plans: PublishingPlan[]; removals: BatchRemovalRecord[]; quota: Record<string, { reservations?: Record<string, unknown> }> };
let root: string; let profile: ReturnType<typeof fixtureJob>["profile"]; let batch: PackageBatch;
/** 建立独立授权的合成设备，兼容发布包及旧扁平批次。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-removal-")); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid");
  const access = emptyAccess(); access.users.push(...[alice, admin].map(user => ({ ...user, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }))); await accessStore().write("access.json", access);
  const pair = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", pair.code, "b".repeat(64)); const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []);
  await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-v2", "publishing-accounts-v1"]); await cloudStore().write("bindings.json", [{ agentId: "pc", instanceId: "main", channelId: "channel_one", confirmed: true }]);
  await savePublishingPolicy(admin, { ...defaultPolicy, privacyContact: "synthetic@example.invalid" }); await acceptPublishingPrivacy(alice, PRIVACY_VERSION);
  const account = await createPublishingAccount(alice, "pc", "main", "Synthetic account"); await claimPublishingAccount("pc", account.id, "main", "channel_one", "Test", true, Date.now());
  profile = await savePublishingProfile(alice, { ...fixtureJob().profile, accountId: account.id });
  batch = { id: "c".repeat(64), name: "Batch01", version: "d".repeat(64), issues: [], packages: Array.from({ length: 3 }, (_, i) => ({ id: String(i + 1).repeat(64), batchName: "Batch01", name: "Package" + (i + 1), version: (i + 10).toString(16).padStart(64, "0"), sourceVideo: fixtureJob().asset, validationState: "valid", issues: [] })) };
  remote.rpc.mockReset(); remote.rpc.mockImplementation(async (_target, _actor, payload) => ({ ...(payload.kind === "publishing-packages" ? { root: "Synthetic/Publishing/Inbox", batches: [batch] } : { assets: Array.from({ length: 3 }, (_, i) => ({ ...fixtureJob().asset, id: String(i + 1).repeat(64), filename: `movie${i}.mp4` })) }), thumbnails: [], channelId: profile.channelId, channel: "Test" }));
});
/** 仅删除本用例新建的临时目录，绝不触碰客户素材。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-removal-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 创建三个旧扁平私密任务，不建立 YouTube 上传会话。 */
async function flat() { const b = await previewPublishingBatch(alice, profile.id, ["1".repeat(64), "2".repeat(64), "3".repeat(64)]); return { id: b.id, jobs: await confirmPublishingBatch(alice, b.id, false, true) }; }
/** 创建发布包草稿或已确认计划。 */
async function plan(confirmed = true) { const p = await previewPublishingPlan(alice, profile.id, batch.id, rule); return { plan: p, jobs: confirmed ? await confirmPublishingPlan(alice, p.id, p.revision, false, true) : [] }; }
/** 生成递增序号报告，可明确测试旧修订与未知结果；不调用任何 YouTube API。 */
async function report(job: VideoJob, state: PublishingReport["state"], fields: Partial<PublishingReport> = {}) { const current = (await publishingView(alice)).jobs.find(value => value.spec.id === job.spec.id)!; return reportPublishing("pc", [{ id: job.spec.id, revision: current.spec.revision, sequence: (current.observed?.sequence || 0) + 1, state, offset: 0, total: current.prepared?.size || job.spec.asset.size, updatedAt: Date.now(), ...fields }]); }
/** 读取内部状态仅用于断言持久事务和预期任务集合，不打印记录。 */
async function saved() { return (await publishingStore().read<Saved>("state.json"))!; }
it.each(["flat", "plan"] as const)("persists %s cancellation and completes only after all current acknowledgements", async kind => {
  const created = kind === "flat" ? await flat() : await plan(); const id = "id" in created ? created.id : created.plan.id; const jobs = created.jobs;
  await writeFile(path.join(root, "source-video.mp4"), "untouched synthetic source");
  const pending = await removePublishingBatch(alice, id); expect(pending.state).toBe("pending"); expect((await saved()).jobs.map(job => job.spec)).toEqual(jobs.map(job => ({ ...job.spec, revision: job.spec.revision + 1, desired: "cancel" })));
  await report(jobs[0], "cancelled", { revision: jobs[0].spec.revision }); expect((await publishingView(alice)).removals[0].completedAt).toBeUndefined();
  for (const job of jobs.slice(0, 2)) await report(job, "cancelled"); expect((await publishingView(alice)).removals[0].completedAt).toBeUndefined();
  await report(jobs[2], "cancelled"); const complete = await removePublishingBatch(alice, id); expect(complete.state).toBe("complete");
  const view = await publishingView(alice); expect(view.jobs).toHaveLength(3); expect(view.profiles).toHaveLength(1); expect(view.removals[0]).toEqual(complete.removal); expect(Object.keys(complete.removal).sort()).toEqual(["batchId", "completedAt", "name", "requestedAt"]);
  expect(await readFile(path.join(root, "source-video.mp4"), "utf8")).toBe("untouched synthetic source");
});
it("serializes concurrent requests and keeps pending deletion retries idempotent", async () => {
  const b = await flat(); const results = await Promise.all([removePublishingBatch(alice, b.id), removePublishingBatch(alice, b.id)]); expect(results[0]).toEqual(results[1]); expect((await saved()).removals).toHaveLength(1);
  vi.setSystemTime(Date.now() + 1000); const again = await removePublishingBatch(alice, b.id); expect(again.removal.requestedAt).toBe(results[0].removal.requestedAt); expect((await saved()).jobs.every(job => job.spec.revision === 2)).toBe(true);
});
it("preserves public and completed private videos but cancels failed and unknown results", async () => {
  const b = await flat(); await report(b.jobs[0], "published", { videoId: "public_video", observedPrivacy: "public" }); await report(b.jobs[1], "completed", { videoId: "private_video", observedPrivacy: "private" }); await report(b.jobs[2], "failed", { offset: b.jobs[2].spec.asset.size });
  await removePublishingBatch(alice, b.id); const jobs = (await saved()).jobs; expect(jobs.slice(0, 2).map(job => job.spec.revision)).toEqual([1, 1]); expect(jobs[2].spec).toMatchObject({ revision: 2, desired: "cancel" });
  await report(b.jobs[2], "needs_attention", { offset: b.jobs[2].spec.asset.size }); expect((await publishingView(alice)).removals[0].completedAt).toBeUndefined();
  await report(b.jobs[2], "published", { videoId: "public_race", observedPrivacy: "public" }); expect((await publishingView(alice)).removals[0].completedAt).toBe(Date.now()); expect((await saved()).jobs[2].observed?.state).toBe("published"); expect(remote.rpc).toHaveBeenCalledTimes(1);
});
it("never treats private completion of a public scheduled job or stale cancellation as safe", () => {
  const spec = fixtureJob(); spec.profile.privacy = "public"; spec.profile.scheduled = true;
  const job: VideoJob = { spec, createdAt: Date.now(), observed: { id: spec.id, revision: spec.revision, sequence: 1, state: "completed", offset: 0, total: spec.asset.size, updatedAt: Date.now(), observedPrivacy: "private" } };
  expect(safeRemovalJob(job)).toBe(false); job.observed!.state = "cancelled"; job.observed!.revision--; expect(safeRemovalJob(job)).toBe(false);
  job.observed!.revision++; job.observed!.observedPrivacy = "public"; expect(safeRemovalJob(job)).toBe(false); job.observed!.state = "published"; expect(safeRemovalJob(job)).toBe(true);
});
it("retries an already failed cancellation once on initial deletion and explicitly per job afterwards", async () => {
  const b = await flat(); const originalCancel = await changePublishingJob(alice, b.jobs[0].spec.id, "cancel"); await report(originalCancel, "failed"); await removePublishingBatch(alice, b.id);
  const initial = (await saved()).jobs[0]; expect(initial.spec.revision).toBe(originalCancel.spec.revision + 1); expect((await changePublishingJob(alice, initial.spec.id, "cancel")).spec.revision).toBe(initial.spec.revision);
  await report(initial, "needs_attention"); const retry = await changePublishingJob(alice, initial.spec.id, "cancel"); expect(retry.spec.revision).toBe(initial.spec.revision + 1); expect(retry.spec.desired).toBe("cancel");
  await removePublishingBatch(alice, b.id); expect((await saved()).jobs[0].spec.revision).toBe(retry.spec.revision);
});
it("blocks new upload admission and mutable controls while keeping cancellation and remote reconciliation", async () => {
  const b = await flat(); const receipt = randomUUID(); await chargePublishing("pc", b.jobs[0].spec.id, receipt, 0, true); await publishingTick();
  await removePublishingBatch(alice, b.id); const rev = (await saved()).jobs[0].spec.revision;
  for (const action of ["pause", "resume", "reschedule"] as const) await expect(changePublishingJob(alice, b.jobs[0].spec.id, action, "2026-10-03T20:00:00Z")).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
  await expect(chargePublishing("pc", b.jobs[0].spec.id, receipt, 0, true)).rejects.toMatchObject({ code: "BATCH_REMOVAL" }); await expect(chargePublishing("pc", b.jobs[0].spec.id, randomUUID(), 1, false)).resolves.toEqual({ ok: true });
  await savePublishingPolicy(admin, { ...defaultPolicy, uploadMbps: 3 }); expect((await saved()).jobs[0].spec.revision).toBe(rev);
  const query = await changePublishingJob(alice, b.jobs[0].spec.id, "reconcile"); expect(query.spec.desired).toBe("cancel"); expect(query.spec.reconcileRevision).toBe(query.spec.revision);
  for (const job of b.jobs) await report(job, "cancelled"); expect((await saved()).quota[defaultPolicy.projectKey].reservations).toEqual({});
  for (const action of ["cancel", "reconcile", "resume"] as const) await expect(changePublishingJob(alice, b.jobs[0].spec.id, action)).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
});
it("accepts an offline deletion and delivers cancellation outside the preupload window on reconnect", async () => {
  const b = await flat(); const store = await saved(); for (const job of store.jobs) job.spec.originalPublishAt = "2031-10-01T20:00:00Z"; await publishingStore().write("state.json", store);
  vi.setSystemTime(Date.now() + 120000); await expect(removePublishingBatch(alice, b.id)).resolves.toMatchObject({ state: "pending" }); await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
  const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []); await publishingTick(); expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(3);
});
it("prevents confirmed-plan repeat confirmation, rescheduling, and archive from bypassing deletion", async () => {
  profile = await savePublishingProfile(alice, { ...profile, revision: profile.revision + 1, privacy: "public", scheduled: true });
  const created = await plan(); const p = (await publishingView(alice)).plans[0]; const preview = await previewPublishingReschedule(alice, p.id, p.revision, { ...rule, startDate: "2026-10-02" });
  await removePublishingBatch(alice, p.id);
  await expect(confirmPublishingPlan(alice, p.id, p.revision, false, true)).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
  await expect(previewPublishingReschedule(alice, p.id, p.revision, rule)).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
  await expect(confirmPublishingReschedule(alice, p.id, p.revision, preview.id)).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
  await expect(updatePublishingPlan(alice, p.id, p.revision, p.items)).rejects.toMatchObject({ code: "BATCH_REMOVAL" });
  await expect(archivePublishingPlan(alice, p.id)).rejects.toMatchObject({ code: "BATCH_REMOVAL" }); expect((await saved()).jobs).toHaveLength(created.jobs.length);
});
it("removes an unconfirmed draft without creating tasks and never allows later confirmation", async () => {
  const { plan: p } = await plan(false); await expect(removePublishingBatch(alice, p.id)).resolves.toMatchObject({ state: "complete" });
  await expect(confirmPublishingPlan(alice, p.id, p.revision, false, true)).rejects.toMatchObject({ code: "BATCH_REMOVAL" }); expect((await saved()).jobs).toEqual([]);
});
it("retains an orphan pending marker after original authorization cleanup instead of declaring empty success", async () => {
  const b = await flat(); await removePublishingBatch(alice, b.id); await report(b.jobs[0], "needs_attention", { authorizationInvalid: true }); const view = await publishingView(alice);
  expect(view.jobs).toEqual([]); expect(view.cleanups[0].state).toBe("pending"); expect(view.removals).toEqual([{ batchId: b.id, requestedAt: Date.now(), name: profile.name }]);
  await acceptPublishingPrivacy(alice, PRIVACY_VERSION); expect((await saved()).removals[0].completedAt).toBeUndefined(); expect((await saved()).removals[0].jobIds).toHaveLength(3);
});
it("cannot confirm removal when expected jobs have disappeared or a confirmed batch is incomplete", async () => {
  const b = await flat(); const state = await saved(); state.jobs.pop(); await publishingStore().write("state.json", state); await removePublishingBatch(alice, b.id);
  for (const job of state.jobs) await report(job, "cancelled"); const record = (await saved()).removals[0]; expect(record.expectedJobs).toBe(3); expect(record.completedAt).toBeUndefined();
  const pure = structuredClone(record); finishBatchRemovals([pure], []); expect(pure.completedAt).toBeUndefined();
});
it("reopens a deleted marker for a newer current unsafe result and ignores superseded late reports", async () => {
  const b = await flat(); await removePublishingBatch(alice, b.id); for (const job of b.jobs) await report(job, "cancelled");
  await report(b.jobs[0], "uploading", { revision: 1, sequence: 100, offset: 1 }); expect((await saved()).removals[0].completedAt).toBe(Date.now()); expect((await saved()).jobs[0].observed?.state).toBe("cancelled");
  await report(b.jobs[0], "needs_attention", { sequence: 101 }); expect((await saved()).removals[0].completedAt).toBeUndefined();
});
it("enforces original ownership, filters markers, and accepts legacy state without removal records", async () => {
  const b = await flat(); const state = await saved(); delete (state as Partial<Saved>).removals; await publishingStore().write("state.json", state); await removePublishingBatch(alice, b.id);
  const bob = { username: "bob", role: "customer" as const }; await expect(removePublishingBatch(bob, b.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await setAgentOwner("pc", "bob"); await acceptPublishingPrivacy(bob, PRIVACY_VERSION); expect((await publishingView(alice)).removals).toEqual([]); expect((await publishingView(bob)).removals).toEqual([]);
  await expect(removePublishingBatch(admin, b.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("uses authenticated same-origin strict batch-remove API with minimal no-store responses", async () => {
  const b = await flat(); const token = "e".repeat(64); const access = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!; access.sessions[digest(token)] = { username: "alice", revision: access.users[0].revision, expires: Date.now() + 60000 }; await accessStore().write("access.json", access);
  const headers = { host: "synthetic.invalid", origin: "https://synthetic.invalid", "x-livepilot": "1", cookie: "livepilot_session=" + token, "content-type": "application/json" };
  const good = await POST(new Request("https://synthetic.invalid/api/publishing", { method: "POST", headers, body: JSON.stringify({ action: "batch-remove", batchId: b.id }) })); expect(good.status).toBe(200); expect(good.headers.get("cache-control")).toBe("no-store"); expect(await good.json()).toMatchObject({ state: "pending", batchId: b.id });
  const invalid = await POST(new Request("https://synthetic.invalid/api/publishing", { method: "POST", headers, body: JSON.stringify({ action: "batch-remove", batchId: b.id, force: true }) })); expect(invalid.status).toBe(400);
  const anonymous = await POST(new Request("https://synthetic.invalid/api/publishing", { method: "POST", headers: { ...headers, cookie: "" }, body: JSON.stringify({ action: "batch-remove", batchId: b.id }) })); expect(anonymous.status).toBe(401);
  const crossSite = await POST(new Request("https://synthetic.invalid/api/publishing", { method: "POST", headers: { ...headers, origin: "https://other.invalid" }, body: JSON.stringify({ action: "batch-remove", batchId: b.id }) })); expect(crossSite.status).toBe(403);
});
