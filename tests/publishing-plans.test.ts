/** 发布包计划集成回归：真实文件事务与权限，Agent 扫描/归档采用合成短 RPC。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const remote = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/cloud/tasks", async importOriginal => ({ ...await importOriginal<typeof import("@/cloud/tasks")>(), rpc: remote.rpc }));
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, setAgentOwner } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { accessStore, emptyAccess } from "@/server/access";
import { acceptPublishingPrivacy, archivePublishingPlan, changePublishingJob, chargePublishing, completePublishingCleanup, confirmPublishingPlan, confirmPublishingReschedule, previewPublishingPlan, previewPublishingReschedule, publishingStore, publishingTick, publishingView, reportPublishing, requestPublishingAccountCleanup, savePublishingPolicy, savePublishingProfile, updatePublishingPlan } from "@/cloud/publishing";
import { occupiedPublishingSlots, schedulePlanSlots } from "@/core/publishing/schedule";
import { AppError } from "@/core/errors";
import { makeProblem } from "@/shared/problems";
import { defaultPolicy, PRIVACY_VERSION, type PackageBatch, type PublishingPlanRule } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";
import { createPublishingAccount, claimPublishingAccount } from "@/cloud/publishing-accounts";
let root: string; let batch: PackageBatch; let profile: ReturnType<typeof fixtureJob>["profile"];
const alice = { username: "alice", role: "customer" as const }; const admin = { username: "admin", role: "admin" as const };
const rule: PublishingPlanRule = { timezone: "UTC", startDate: "2026-10-01", weeklySlots: [{ weekday: 4, time: "20:00" }, { weekday: 4, time: "21:00" }, { weekday: 5, time: "09:00" }], preuploadDays: 28 };
/** 两个不同包中的同名 video.mp4 不构成重复；同一包的 ID 随修订保留。 */
function packageBatch(count = 2): PackageBatch {
  return { id: "c".repeat(64), name: "Batch01", version: "d".repeat(64), issues: [], packages: Array.from({ length: count }, (_, index) => ({ id: String(index + 1).repeat(64), batchName: "Batch01", name: "Package" + (index + 1), version: (index + 10).toString(16).padStart(64, "0"), sourceVideo: { ...fixtureJob().asset, filename: "video.mp4" }, validationState: "valid", issues: [], ...(index === 0 ? { title: "Package title", description: "Package description" } : {}) })) };
}
it("requires planned publication for a new public package batch without changing an old immediate-public Profile", async () => {
  const saved = await savePublishingProfile(alice, { ...profile, revision: profile.revision + 1, scheduled: false }); profile = saved;
  const plan = await preview(); expect(plan.profile.scheduled).toBe(true); expect(plan.items.every(item => !!item.publishAt)).toBe(true);
  expect((await publishingView(alice)).profiles.find(value => value.id === profile.id)?.scheduled).toBe(false);
});
/** 独立合成 Cloud 与设备，所有 API 和媒体副作用都被替换为测试数据。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-plans-")); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T00:00:00Z")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main");
  const access = emptyAccess(); access.users.push(...[alice, admin].map(user => ({ ...user, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }))); await accessStore().write("access.json", access);
  const pair = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", pair.code, "b".repeat(64)); const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []); await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-v2", "publishing-accounts-v1"]);
  await cloudStore().write("bindings.json", [{ agentId: "pc", instanceId: "main", channelId: "channel_one", confirmed: true }]); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, publicVerified: true, privacyContact: "synthetic@example.invalid", verificationNote: "Synthetic fixture only" }); await acceptPublishingPrivacy(alice, PRIVACY_VERSION);
  const account = await createPublishingAccount(alice, "pc", "main", "Package fixture"); await claimPublishingAccount("pc", account.id, "main", "channel_one", "Test", true, Date.now());
  batch = packageBatch(); profile = { ...fixtureJob().profile, accountId: account.id, privacy: "public", scheduled: true, titleTemplate: "{{packageName}}" }; await savePublishingProfile(alice, profile);
  remote.rpc.mockReset(); remote.rpc.mockImplementation(async (_target, _actor, payload) => payload.kind === "publishing-archive" ? { state: "complete", destination: "Synthetic/Publishing/Completed/Batch01" } : { root: "Synthetic/Publishing/Inbox", batches: [structuredClone(batch)], thumbnails: [], channelId: "channel_one", channel: "Test" });
});
/** 删除仅属于本次测试的临时目录，不接触用户源视频。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-plans-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 默认创建完整包快照，便于测试后续修订和确认。 */
async function preview() { return previewPublishingPlan(alice, profile.id, batch.id, rule); }
/** 新发布包无管理员开启/验收门槛；批次确认同意、目标身份和真实 YouTube 状态仍独立验证。 */
it("confirms a package plan with legacy false policy flags without requiring an administrator session", async () => {
  const plan = await preview(); const saved = await publishingStore().read<{ policy: typeof defaultPolicy }>("state.json");
  saved!.policy.enabled = false; saved!.policy.publicVerified = false; saved!.policy.verificationNote = ""; await publishingStore().write("state.json", saved);
  await expect(confirmPublishingPlan(alice, plan.id, plan.revision, false, false)).rejects.toMatchObject({ code: "CONSENT" });
  const jobs = await confirmPublishingPlan(alice, plan.id, plan.revision, false, true);
  expect(jobs).toHaveLength(plan.items.length); expect(jobs[0].spec.policy).toMatchObject({ enabled: true, publicVerified: true, verificationNote: "" });
  expect(jobs.every(job => !job.observed)).toBe(true); expect(jobs.map(job => job.spec.originalPublishAt)).toEqual(plan.items.map(item => item.publishAt));
});
/** 设备扫描晚于授权删除返回时，不能把已清理的发布包快照重新写回 Cloud。 */
it("rejects a package preview returning after account cleanup is complete", async () => {
  let finishScan!: (value: unknown) => void; let scanning!: () => void;
  const started = new Promise<void>(resolve => { scanning = resolve; });
  remote.rpc.mockImplementationOnce(() => { scanning(); return new Promise(resolve => { finishScan = resolve; }); });
  const pending = preview(); const rejected = expect(pending).rejects.toMatchObject({ code: "CLEANUP" }); await started;
  const cleanup = await requestPublishingAccountCleanup(alice, profile.accountId!); await completePublishingCleanup("pc", cleanup.id);
  finishScan({ root: "Synthetic/Publishing/Inbox", batches: [batch], thumbnails: [], channelId: profile.channelId });
  await rejected; const view = await publishingView(alice); expect(view.profiles).toEqual([]); expect(view.plans).toEqual([]); expect(view.jobs).toEqual([]);
});
/** 扫描开始时的管理员/客户设备归属不能授权扫描结束后的持久写入。 */
it("rejects a package preview returning after device reassignment", async () => {
  let finishScan!: (value: unknown) => void; let scanning!: () => void;
  const started = new Promise<void>(resolve => { scanning = resolve; });
  remote.rpc.mockImplementationOnce(() => { scanning(); return new Promise(resolve => { finishScan = resolve; }); });
  const pending = preview(); const rejected = expect(pending).rejects.toMatchObject({ code: "FORBIDDEN" }); await started;
  await setAgentOwner("pc", "bob"); finishScan({ root: "Synthetic/Publishing/Inbox", batches: [batch], thumbnails: [], channelId: profile.channelId });
  await rejected; expect((await publishingStore().read<{ plans: unknown[] }>("state.json"))!.plans).toEqual([]);
});
it("supports same-day slots, occupied times and DST gap/overlap", () => {
  const scheduled = schedulePlanSlots(rule, 3, [Date.parse("2026-10-01T20:00:00Z")], Date.now()); expect(scheduled.slots.map(slot => slot.publishAt)).toEqual(["2026-10-01T21:00:00Z", "2026-10-02T09:00:00Z", "2026-10-08T20:00:00Z"]); expect(scheduled.skippedOccupied).toBe(1);
  const spring = schedulePlanSlots({ ...rule, timezone: "America/New_York", startDate: "2026-03-08", weeklySlots: [{ weekday: 7, time: "02:30" }] }, 1, [], Date.parse("2026-03-01T00:00:00Z")); expect(spring.skipped).toHaveLength(1); expect(spring.slots[0].publishAt).toBe("2026-03-15T06:30:00Z");
  const fall = schedulePlanSlots({ ...rule, timezone: "America/New_York", startDate: "2026-11-01", weeklySlots: [{ weekday: 7, time: "01:30" }, { weekday: 7, time: "01:30" }] }, 1); expect(fall.slots[0]).toMatchObject({ publishAt: "2026-11-01T05:30:00Z", overlapping: true });
});
it("persists draft revisions and freezes package/Profile snapshots", async () => {
  const plan = await preview(); expect(plan.copies.map(copy => copy.title)).toEqual(["Package title", "Package2"]); const changed = await updatePublishingPlan(alice, plan.id, 1, [{ ...plan.items[0], title: "Manual" }, { ...plan.items[1], description: "" }]); expect(changed.revision).toBe(2); expect(changed.copies[0].title).toBe("Manual"); expect(changed.copies[1].description).toBe(""); await expect(updatePublishingPlan(alice, plan.id, 1, plan.items)).rejects.toMatchObject({ code: "REVISION" });
  await savePublishingProfile(alice, { ...profile, revision: 2, titleTemplate: "Changed" }); expect((await publishingView(alice)).plans[0].profile.titleTemplate).toBe("{{packageName}}"); expect((await publishingView({ username: "bob", role: "customer" })).plans).toEqual([]);
});
it("keeps manual slots fixed and excluded/invalid packages without creating jobs", async () => {
  batch.packages[1].validationState = "invalid"; batch.packages[1].issues = ["Missing video"]; const plan = await preview(); await expect(confirmPublishingPlan(alice, plan.id, 1, false, true)).rejects.toMatchObject({ code: "PACKAGE" });
  const fixed = "2026-10-02T08:00:00Z"; const changed = await updatePublishingPlan(alice, plan.id, 1, [{ ...plan.items[0], scheduleSource: "manual", publishAt: fixed }, { ...plan.items[1], excluded: true }], { ...rule, weeklySlots: [{ weekday: 6, time: "23:00" }] }); expect(changed.items[0].publishAt).toBe(fixed); expect(changed.items[1].publishAt).toBeUndefined(); const jobs = await confirmPublishingPlan(alice, changed.id, changed.revision, false, true); expect(jobs).toHaveLength(1); expect(jobs[0].spec.originalPublishAt).toBe(fixed); await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "ARCHIVE" });
});
it("confirms idempotently while treating identical video filenames as different packages", async () => { const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); expect(jobs).toHaveLength(2); expect(jobs.map(job => job.spec.contentPackage?.name)).toEqual(["Package1", "Package2"]); expect((await confirmPublishingPlan(alice, plan.id, 1, false, true)).map(job => job.spec.id)).toEqual(jobs.map(job => job.spec.id)); });
it("rejects changed package versions and channel changes at confirmation", async () => { const plan = await preview(); batch.version = "e".repeat(64); await expect(confirmPublishingPlan(alice, plan.id, 1, false, true)).rejects.toMatchObject({ code: "PACKAGE_CHANGED" }); batch.version = plan.batch.version; remote.rpc.mockResolvedValue({ root: "Synthetic", batches: [batch], channelId: "channel_other" }); await expect(confirmPublishingPlan(alice, plan.id, 1, false, true)).rejects.toMatchObject({ code: "CHANNEL" }); });
it("rejects a racing confirmed slot and requires refresh without silently moving preview", async () => { const first = await preview(); const second = await preview(); await confirmPublishingPlan(alice, first.id, 1, false, true); await expect(confirmPublishingPlan(alice, second.id, 1, false, true)).rejects.toMatchObject({ code: "CONFLICT" }); expect((await publishingView(alice)).plans.find(plan => plan.id === second.id)?.items[0].publishAt).toBe(second.items[0].publishAt); });
it("occupies current/effective/pending-change times until the current cancellation is acknowledged", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "scheduled", offset: 0, total: job.spec.asset.size, effectivePublishAt: "2026-10-01T22:00:00Z", updatedAt: Date.now() }]); await changePublishingJob(alice, job.spec.id, "reschedule", "2026-10-03T22:00:00Z"); await changePublishingJob(alice, job.spec.id, "cancel");
  let current = (await publishingView(alice)).jobs.find(value => value.spec.id === job.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one").size).toBe(3); await reportPublishing("pc", [{ id: job.spec.id, revision: current.spec.revision - 1, sequence: 2, state: "cancelled", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); current = (await publishingView(alice)).jobs.find(value => value.spec.id === job.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one").size).toBe(3); await reportPublishing("pc", [{ ...current.observed!, revision: current.spec.revision, sequence: 3 }]); current = (await publishingView(alice)).jobs.find(value => value.spec.id === job.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one").size).toBe(0);
});
it("fixes final output size before progress and ignores stale pre-preparation reports", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); const base = { id: job.spec.id, revision: 1, updatedAt: Date.now(), state: "uploading" as const }; const prepared = { size: 999000, version: "f".repeat(64), sha256: "e".repeat(64) };
  await expect(reportPublishing("pc", [{ ...base, sequence: 1, offset: 1, total: prepared.size, prepared }])).rejects.toMatchObject({ code: "REPORT" }); await reportPublishing("pc", [{ ...base, sequence: 2, offset: 0, total: prepared.size, prepared }]); await reportPublishing("pc", [{ ...base, sequence: 1, offset: 0, total: job.spec.asset.size }]); await reportPublishing("pc", [{ ...base, sequence: 3, offset: 500, total: prepared.size, prepared }]); expect((await publishingView(alice)).jobs[0].prepared).toEqual(prepared);
  await expect(reportPublishing("pc", [{ ...base, sequence: 4, offset: 0, total: prepared.size, prepared: { ...prepared, sha256: "d".repeat(64) } }])).rejects.toMatchObject({ code: "REPORT" }); await expect(reportPublishing("pc", [{ ...base, sequence: 4, offset: 1, total: job.spec.asset.size }])).rejects.toMatchObject({ code: "REPORT" });
});
it("dispatches package jobs only to v2 and respects the plan window instead of the old Profile window", async () => {
  const plan = await preview(); const changed = await updatePublishingPlan(alice, plan.id, 1, plan.items, { ...rule, startDate: "2026-10-08", preuploadDays: 2 }); await confirmPublishingPlan(alice, changed.id, changed.revision, false, true); await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
  await agentStore("pc").write("capabilities.json", ["publishing-v1"]); await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull(); await agentStore("pc").write("capabilities.json", ["publishing-v2", "publishing-accounts-v1"]);
  await updateToDueWindow(); await publishingTick(); expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(2);
});
/** 修改测试存储中的窗口，只用于验证调度能力，不替代真实 API 验收。 */
async function updateToDueWindow() { const state = await publishingStore().read<{ jobs: { spec: { plan: PublishingPlanRule } }[] }>("state.json"); for (const job of state!.jobs) job.spec.plan.preuploadDays = 28; await publishingStore().write("state.json", state); }
it("hides plans and blocks former-owner edits after device reassignment", async () => { const plan = await preview(); await setAgentOwner("pc", "bob"); const bob = { username: "bob", role: "customer" as const }; await acceptPublishingPrivacy(bob, PRIVACY_VERSION); expect((await publishingView(bob)).plans).toEqual([]); await expect(updatePublishingPlan(alice, plan.id, 1, plan.items)).rejects.toMatchObject({ code: "FORBIDDEN" }); });
it("requires explicit replacement for a cancelled old remote video and keeps the old linkage", async () => {
  const first = await preview(); const jobs = await confirmPublishingPlan(alice, first.id, 1, false, true); for (const job of jobs) { const cancelled = await changePublishingJob(alice, job.spec.id, "cancel"); await reportPublishing("pc", [{ id: job.spec.id, revision: cancelled.spec.revision, sequence: 1, state: "cancelled", videoId: "old_video_" + job.spec.index, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); }
  batch.version = "e".repeat(64); for (const pkg of batch.packages) pkg.version = "f".repeat(64); const second = await preview(); await expect(confirmPublishingPlan(alice, second.id, 1, false, true)).rejects.toMatchObject({ code: "DUPLICATE" }); const replacements = await confirmPublishingPlan(alice, second.id, 1, false, true, jobs.map(job => job.spec.id)); expect(replacements).toHaveLength(2); expect((await publishingView(alice)).jobs.filter(job => job.observed?.videoId)).toHaveLength(2);
});
it("archives only true published/completed batches, records pending failures and retries safely", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "ARCHIVE" }); for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  remote.rpc.mockRejectedValueOnce(new Error("Synthetic interruption")); expect(await archivePublishingPlan(alice, plan.id)).toMatchObject({ state: "pending" }); expect((await publishingView(alice)).plans[0].archivePending).toBe(true); const result = await archivePublishingPlan(alice, plan.id); expect(result.state).toBe("complete"); expect((await publishingView(alice)).plans[0].archivedAt).toBe(Date.now()); const count = remote.rpc.mock.calls.length; expect(await archivePublishingPlan(alice, plan.id)).toEqual(result); expect(remote.rpc.mock.calls).toHaveLength(count);
});
it.each(["published", "completed"] as const)("keeps durable publication evidence after API cache expiry (%s)", async state => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: job.spec.revision, sequence: 1, state, observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  vi.setSystemTime(new Date("2026-11-02T00:00:00Z")); await publishingTick(); const current = (await publishingView(alice)).jobs;
  expect(current.every(job => job.observed?.state === state && job.observed.observedPrivacy === undefined)).toBe(true);
  const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []);
  if (state === "published") expect(await archivePublishingPlan(alice, plan.id)).toMatchObject({ state: "complete" });
  else await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "ARCHIVE" });
});
it("loads state created by the old implementation without a plans property", async () => { const state = await publishingStore().read<Record<string, unknown>>("state.json"); delete state!.plans; await publishingStore().write("state.json", state); expect((await publishingView(alice)).plans).toEqual([]); });
it("archives by completed current package coverage and invalidates abandoned drafts", async () => {
  const draft = await preview(); const first = await preview(); const partial = await updatePublishingPlan(alice, first.id, 1, first.items.map((item, index) => ({ ...item, excluded: index === 1 }))); const [one] = await confirmPublishingPlan(alice, partial.id, partial.revision, false, true); await reportPublishing("pc", [{ id: one.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: one.spec.asset.size, updatedAt: Date.now() }]); await expect(archivePublishingPlan(alice, first.id)).rejects.toMatchObject({ code: "ARCHIVE" });
  const second = await preview(); const rest = await updatePublishingPlan(alice, second.id, 1, second.items.map((item, index) => ({ ...item, excluded: index === 0 }))); const [two] = await confirmPublishingPlan(alice, rest.id, rest.revision, false, true); await reportPublishing("pc", [{ id: two.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: two.spec.asset.size, updatedAt: Date.now() }]); expect((await archivePublishingPlan(alice, second.id)).state).toBe("complete"); await expect(confirmPublishingPlan(alice, draft.id, 1, false, true)).rejects.toMatchObject({ code: "ARCHIVE" }); await expect(updatePublishingPlan(alice, draft.id, 1, draft.items)).rejects.toMatchObject({ code: "ARCHIVE" }); expect((await confirmPublishingPlan(alice, first.id, partial.revision, false, true))[0].spec.id).toBe(one.spec.id);
});
it("keeps safe archive permission errors visible instead of reporting successful progress", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); remote.rpc.mockRejectedValueOnce(new AppError("STORAGE_PERMISSION", "本机文件访问被拒绝，请核对目录权限。", 409)); await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "STORAGE_PERMISSION" }); expect((await publishingView(alice)).plans[0].archivedAt).toBeUndefined(); expect((await publishingView(alice)).plans[0].archivePending).toBe(true);
});
it.each(["ARCHIVE_SOURCE_CHANGED", "ARCHIVE_CONFLICT"])("releases archive protection only when the Agent proves no move occurred (%s)", async code => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); remote.rpc.mockRejectedValueOnce(new AppError("AGENT_TASK", "设备拒绝了归档。", 409, makeProblem(code, "源目录没有移动。", { source: "agent", outcome: "rejected" })));
  await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "AGENT_TASK" }); expect((await publishingView(alice)).plans[0].archivePending).toBe(false); batch.version = "e".repeat(64); expect((await preview()).batch.version).toBe(batch.version);
});
it("keeps archive protection when a post-move verification failure has an unknown outcome", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); remote.rpc.mockRejectedValueOnce(new AppError("AGENT_TASK", "归档结果需要核对。", 409, makeProblem("ASSET_CHANGED", "移动后核对未完成。", { source: "agent", outcome: "unknown" })));
  await expect(archivePublishingPlan(alice, plan.id)).rejects.toMatchObject({ code: "AGENT_TASK" }); expect((await publishingView(alice)).plans[0].archivePending).toBe(true); await expect(preview()).rejects.toMatchObject({ code: "ARCHIVE" });
});
it("preserves upload history after API expiry and requires explicit replacement of a changed package version", async () => {
  batch = packageBatch(1); const first = await preview(); const [job] = await confirmPublishingPlan(alice, first.id, 1, false, true); const cancelled = await changePublishingJob(alice, job.spec.id, "cancel"); await reportPublishing("pc", [{ id: job.spec.id, revision: cancelled.spec.revision, sequence: 1, state: "cancelled", videoId: "old_video", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); vi.setSystemTime(new Date("2026-11-02T00:00:00Z")); await publishingTick(); const old = (await publishingView(alice)).jobs[0]; expect(old.observed?.videoId).toBeUndefined(); expect(old.hadUpload).toBe(true);
  const connection = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", connection.session, []); const same = await preview(); await expect(confirmPublishingPlan(alice, same.id, 1, false, true)).rejects.toMatchObject({ code: "DUPLICATE" }); await expect(confirmPublishingPlan(alice, same.id, 1, false, true, [job.spec.id])).rejects.toMatchObject({ code: "REPLACEMENT" }); batch.version = "e".repeat(64); batch.packages[0].version = "f".repeat(64); const changed = await preview(); await expect(confirmPublishingPlan(alice, changed.id, 1, false, true)).rejects.toMatchObject({ code: "DUPLICATE" }); expect(await confirmPublishingPlan(alice, changed.id, 1, false, true, [job.spec.id])).toHaveLength(1); expect((await publishingView(alice)).jobs).toHaveLength(2);
});
it("remembers successful upload admission even if no video ID or progress report arrives", async () => {
  batch = packageBatch(1); const first = await preview(); const [job] = await confirmPublishingPlan(alice, first.id, 1, false, true); await chargePublishing("pc", job.spec.id, randomUUID(), 0, true); const cancelled = await changePublishingJob(alice, job.spec.id, "cancel"); await reportPublishing("pc", [{ id: job.spec.id, revision: cancelled.spec.revision, sequence: 1, state: "cancelled", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); expect((await publishingView(alice)).jobs[0].hadUpload).toBe(true); const same = await preview(); await expect(confirmPublishingPlan(alice, same.id, 1, false, true)).rejects.toMatchObject({ code: "DUPLICATE" });
});
it("keeps one archive ID per batch while allowing the original pending plan to reconcile", async () => {
  const first = await preview(); const other = await preview(); const jobs = await confirmPublishingPlan(alice, first.id, 1, false, true); for (const job of jobs) await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "published", observedPrivacy: "public", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); remote.rpc.mockRejectedValueOnce(new Error("Synthetic unknown result")); expect(await archivePublishingPlan(alice, first.id)).toMatchObject({ state: "pending" }); await expect(archivePublishingPlan(alice, other.id)).rejects.toMatchObject({ code: "ARCHIVE_BUSY" }); expect((await archivePublishingPlan(alice, first.id)).state).toBe("complete");
});
it("releases the old remote slot after successful reschedule while retaining historical display time", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); const actual = "2026-10-01T22:00:00Z"; await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "scheduled", effectivePublishAt: actual, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); const at = "2026-10-03T22:00:00Z"; const revised = await changePublishingJob(alice, job.spec.id, "reschedule", at); await reportPublishing("pc", [{ id: job.spec.id, revision: revised.spec.revision, sequence: 2, state: "finalizing", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); let current = (await publishingView(alice)).jobs[0]; expect(occupiedPublishingSlots([current], "channel_one").has(Date.parse(actual))).toBe(true); await reportPublishing("pc", [{ id: job.spec.id, revision: revised.spec.revision, sequence: 3, state: "scheduled", effectivePublishAt: at, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]); current = (await publishingView(alice)).jobs[0]; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([Date.parse(at)])); expect(current.initialPublishAt).toBe(job.initialPublishAt);
});

it("previews confirmed plan times without changing uploads, then revises the same jobs and account", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, plan.revision, false, true);
  await reportPublishing("pc", [{ id: jobs[0].spec.id, revision: 1, sequence: 1, state: "scheduled", videoId: "existing_video", effectivePublishAt: jobs[0].spec.originalPublishAt, offset: 0, total: jobs[0].spec.asset.size, updatedAt: Date.now() }]);
  const updatedRule = { ...rule, weeklySlots: [{ weekday: 5, time: "11:00" }] };
  const draft = await previewPublishingReschedule(alice, plan.id, plan.revision, updatedRule);
  expect(draft).toMatchObject({ id: plan.id, revision: 1, confirmedAt: Date.now(), schedulePreviewId: expect.any(String) });
  expect(draft.items[0].publishAt).toBe("2026-10-02T11:00:00Z"); expect((await publishingView(alice)).jobs.map(job => job.spec.originalPublishAt)).toEqual(jobs.map(job => job.spec.originalPublishAt));
  const saved = await publishingStore().read<{ schedulePreviews: unknown[] }>("state.json"); expect(saved?.schedulePreviews).toHaveLength(1);
  const changed = await confirmPublishingReschedule(alice, plan.id, plan.revision, draft.schedulePreviewId!); const current = (await publishingView(alice)).jobs;
  expect(changed.revision).toBe(2); expect(changed.schedulePreviewId).toBeUndefined(); expect(current.map(job => job.spec.id)).toEqual(jobs.map(job => job.spec.id)); expect(current.map(job => job.spec.revision)).toEqual([2, 2]);
  expect(current[0]).toMatchObject({ initialPublishAt: jobs[0].initialPublishAt, pendingPublishAt: jobs[0].spec.originalPublishAt, hadUpload: true, observed: { videoId: "existing_video" }, spec: { profile: jobs[0].spec.profile, asset: jobs[0].spec.asset, contentPackage: jobs[0].spec.contentPackage, overrides: jobs[0].spec.overrides } });
  expect(await confirmPublishingReschedule(alice, plan.id, plan.revision, draft.schedulePreviewId!)).toEqual(changed); expect((await publishingView(alice)).jobs.map(job => job.spec.revision)).toEqual([2, 2]);
});

it("keeps manual and excluded packages fixed while changing only automatic remaining times", async () => {
  batch = packageBatch(3); const plan = await preview(); const fixed = "2026-10-02T08:00:00Z";
  const arranged = await updatePublishingPlan(alice, plan.id, 1, plan.items.map((item, index) => index === 0 ? { ...item, scheduleSource: "manual", publishAt: fixed } : index === 2 ? { ...item, excluded: true } : item));
  const jobs = await confirmPublishingPlan(alice, plan.id, arranged.revision, false, true);
  const draft = await previewPublishingReschedule(alice, plan.id, arranged.revision, { ...rule, weeklySlots: [{ weekday: 6, time: "12:00" }] });
  expect(draft.items[0].publishAt).toBe(fixed); expect(draft.items[1].publishAt).toBe("2026-10-03T12:00:00Z"); expect(draft.items[2]).toMatchObject({ excluded: true }); expect(draft.scheduleLockedPackageIds).toContain(plan.items[2].packageId);
  await confirmPublishingReschedule(alice, plan.id, arranged.revision, draft.schedulePreviewId!); expect((await publishingView(alice)).jobs.map(job => job.spec.id)).toEqual(jobs.map(job => job.spec.id));
  await expect(previewPublishingReschedule(alice, plan.id, arranged.revision + 1, rule, draft.items.map((item, index) => index === 0 ? { ...item, title: "Changed after confirmation" } : item))).rejects.toMatchObject({ code: "INPUT" });
});

it("keeps an individual job time override when later regenerating the batch schedule", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); const fixed = "2026-10-05T16:00:00Z";
  const overridden = await changePublishingJob(alice, job.spec.id, "reschedule", fixed); expect(overridden.spec.scheduleSource).toBe("manual");
  const currentPlan = (await publishingView(alice)).plans.find(value => value.id === plan.id)!; expect(currentPlan.revision).toBe(2); expect(currentPlan.items[0]).toMatchObject({ scheduleSource: "manual", publishAt: fixed });
  const draft = await previewPublishingReschedule(alice, plan.id, currentPlan.revision, { ...rule, weeklySlots: [{ weekday: 7, time: "17:00" }] }); expect(draft.items[0].publishAt).toBe(fixed);
});

it("preserves paused intent and locks completed, cancelled, failed and attention packages", async () => {
  batch = packageBatch(7); const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  for (const [index, state] of (["published", "completed", "cancelled", "failed", "needs_attention"] as const).entries()) await reportPublishing("pc", [{ id: jobs[index].spec.id, revision: 1, sequence: 1, state, offset: 0, total: jobs[index].spec.asset.size, updatedAt: Date.now() }]);
  const paused = await changePublishingJob(alice, jobs[5].spec.id, "pause"); await changePublishingJob(alice, jobs[6].spec.id, "cancel");
  const before = (await publishingView(alice)).jobs; const draft = await previewPublishingReschedule(alice, plan.id, 1, { ...rule, weeklySlots: [{ weekday: 7, time: "13:00" }] });
  expect(draft.scheduleLockedPackageIds).toHaveLength(6); await confirmPublishingReschedule(alice, plan.id, 1, draft.schedulePreviewId!); const current = (await publishingView(alice)).jobs;
  expect(current.filter((_, index) => index !== 5)).toEqual(before.filter((_, index) => index !== 5)); expect(current[5].spec.desired).toBe("pause"); expect(current[5].spec.revision).toBe(paused.spec.revision + 1); expect(current[5].spec.originalPublishAt).not.toBe(paused.spec.originalPublishAt);
});

it("accepts harmless upload progress but rejects publication or a racing control revision", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const nextRule = { ...rule, weeklySlots: [{ weekday: 6, time: "11:00" }] };
  const first = await previewPublishingReschedule(alice, plan.id, 1, nextRule);
  await reportPublishing("pc", [{ id: jobs[0].spec.id, revision: 1, sequence: 1, state: "processing", offset: 0, total: jobs[0].spec.asset.size, updatedAt: Date.now() }]);
  await confirmPublishingReschedule(alice, plan.id, 1, first.schedulePreviewId!);
  const second = await previewPublishingReschedule(alice, plan.id, 2, { ...nextRule, weeklySlots: [{ weekday: 7, time: "11:00" }] });
  await reportPublishing("pc", [{ id: jobs[0].spec.id, revision: 2, sequence: 2, state: "published", observedPrivacy: "public", offset: 0, total: jobs[0].spec.asset.size, updatedAt: Date.now() }]);
  await expect(confirmPublishingReschedule(alice, plan.id, 2, second.schedulePreviewId!)).rejects.toMatchObject({ code: "REVISION" });
  const third = await previewPublishingReschedule(alice, plan.id, 2, nextRule); await changePublishingJob(alice, jobs[1].spec.id, "pause"); await expect(confirmPublishingReschedule(alice, plan.id, 2, third.schedulePreviewId!)).rejects.toMatchObject({ code: "REVISION" });
});

it("rejects another batch occupying the shown replacement time without partially applying", async () => {
  const plan = await preview(); await confirmPublishingPlan(alice, plan.id, 1, false, true);
  const draft = await previewPublishingReschedule(alice, plan.id, 1, { ...rule, weeklySlots: [{ weekday: 6, time: "14:00" }] });
  batch = { ...packageBatch(1), id: "e".repeat(64), name: "Another batch", packages: [{ ...packageBatch(1).packages[0], id: "f".repeat(64), batchName: "Another batch" }] };
  const other = await preview(); const fixed = await updatePublishingPlan(alice, other.id, 1, [{ ...other.items[0], scheduleSource: "manual", publishAt: draft.items[0].publishAt }]); await confirmPublishingPlan(alice, fixed.id, fixed.revision, false, true);
  const before = (await publishingView(alice)).jobs; await expect(confirmPublishingReschedule(alice, plan.id, 1, draft.schedulePreviewId!)).rejects.toMatchObject({ code: "CONFLICT" }); expect((await publishingView(alice)).jobs).toEqual(before);
});

it("preserves progress with the final output and permits offline schedule confirmation", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const prepared = { version: "e".repeat(64), sha256: "f".repeat(64), size: 999 };
  await reportPublishing("pc", [{ id: jobs[0].spec.id, revision: 1, sequence: 1, state: "uploading", offset: 0, total: prepared.size, prepared, updatedAt: Date.now() }]);
  vi.setSystemTime(new Date("2026-10-01T01:00:00Z")); const draft = await previewPublishingReschedule(alice, plan.id, 1, { ...rule, weeklySlots: [{ weekday: 6, time: "15:00" }] });
  await reportPublishing("pc", [{ id: jobs[0].spec.id, revision: 1, sequence: 2, state: "uploading", offset: 500, total: prepared.size, updatedAt: Date.now() }]);
  await confirmPublishingReschedule(alice, plan.id, 1, draft.schedulePreviewId!); const current = (await publishingView(alice)).jobs[0]; expect(current.prepared).toEqual(prepared); expect(current.observed?.offset).toBe(500); expect(current.spec.id).toBe(jobs[0].spec.id); expect(current.spec.revision).toBe(2);
});

it("releases a rejected new time only after the Agent confirms the actual published result", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); const actual = job.spec.originalPublishAt!;
  await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 1, state: "scheduled", effectivePublishAt: actual, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const future = "2026-10-04T18:00:00Z"; const revised = await changePublishingJob(alice, job.spec.id, "reschedule", future);
  await reportPublishing("pc", [{ id: job.spec.id, revision: 1, sequence: 2, state: "published", effectivePublishAt: actual, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  let current = (await publishingView(alice)).jobs[0]; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([Date.parse(actual), Date.parse(future)]));
  await reportPublishing("pc", [{ id: job.spec.id, revision: revised.spec.revision, sequence: 3, state: "published", effectivePublishAt: actual, observedPrivacy: "public", message: "视频已公开，改期未应用。", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  current = (await publishingView(alice)).jobs[0]; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([Date.parse(actual)])); expect(current.spec.originalPublishAt).toBe(future); expect(current.initialPublishAt).toBe(actual); expect(current.pendingPublishAt).toBeUndefined();
  expect(occupiedPublishingSlots([{ ...current, observed: { ...current.observed!, effectivePublishAt: undefined } }], "channel_one")).toEqual(new Set([Date.parse(actual)]));
});

it("keeps automatic times unchanged when the confirmed rule has not changed", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  const draft = await previewPublishingReschedule(alice, plan.id, 1, rule); expect(draft.items.map(item => item.publishAt)).toEqual(jobs.map(job => job.spec.originalPublishAt));
  await confirmPublishingReschedule(alice, plan.id, 1, draft.schedulePreviewId!); expect((await publishingView(alice)).jobs.map(job => job.spec.revision)).toEqual([1, 1]);
});

it.each(["original", "remote", "pending"] as const)("does not let a new item steal another same-batch Job's unacknowledged %s time", async kind => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  const remoteAt = "2026-10-01T22:00:00Z"; const oldAt = kind === "remote" ? remoteAt : jobs[1].spec.originalPublishAt!;
  if (kind === "remote") await reportPublishing("pc", [{ id: jobs[1].spec.id, revision: 1, sequence: 1, state: "scheduled", effectivePublishAt: remoteAt, offset: 0, total: jobs[1].spec.asset.size, updatedAt: Date.now() }]);
  if (kind === "pending") await changePublishingJob(alice, jobs[1].spec.id, "reschedule", "2026-10-03T16:00:00Z");
  const current = (await publishingView(alice)).plans.find(value => value.id === plan.id)!;
  const nextRule = { ...rule, weeklySlots: [{ weekday: 4, time: oldAt.slice(11, 16) }] };
  const draft = await previewPublishingReschedule(alice, plan.id, current.revision, nextRule);
  expect(draft.items[0].publishAt).not.toBe(oldAt); expect(Date.parse(draft.items[0].publishAt!)).toBeGreaterThan(Date.parse(oldAt));
  await expect(previewPublishingReschedule(alice, plan.id, current.revision, nextRule, current.items.map((item, index) => index === 0 ? { ...item, scheduleSource: "manual", publishAt: oldAt } : item))).rejects.toMatchObject({ code: "CONFLICT" });
  await confirmPublishingReschedule(alice, plan.id, current.revision, draft.schedulePreviewId!); const changed = (await publishingView(alice)).jobs;
  expect(changed[0].spec.originalPublishAt).not.toBe(oldAt); expect(occupiedPublishingSlots([changed[1]], "channel_one").has(Date.parse(oldAt))).toBe(true);
});

it("allows a same-batch old Slot to be reused only after its owner acknowledges the new schedule", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const oldAt = jobs[1].spec.originalPublishAt!;
  const changedJob = await changePublishingJob(alice, jobs[1].spec.id, "reschedule", "2026-10-03T17:00:00Z");
  await reportPublishing("pc", [{ id: changedJob.spec.id, revision: changedJob.spec.revision, sequence: 1, state: "scheduled", effectivePublishAt: changedJob.spec.originalPublishAt, offset: 0, total: changedJob.spec.asset.size, updatedAt: Date.now() }]);
  const current = (await publishingView(alice)).plans.find(value => value.id === plan.id)!;
  const draft = await previewPublishingReschedule(alice, plan.id, current.revision, rule, current.items.map((item, index) => index === 0 ? { ...item, scheduleSource: "manual", publishAt: oldAt } : item));
  expect(draft.items[0].publishAt).toBe(oldAt); await confirmPublishingReschedule(alice, plan.id, current.revision, draft.schedulePreviewId!);
});

it("rejects an older persisted preview that reused another Job's still-active Slot", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const oldAt = jobs[1].spec.originalPublishAt!;
  const draft = await previewPublishingReschedule(alice, plan.id, 1, { ...rule, weeklySlots: [{ weekday: 4, time: "21:00" }] });
  const state = await publishingStore().read<{ schedulePreviews: { plan: { items: { publishAt?: string }[] } }[] }>("state.json"); state!.schedulePreviews[0].plan.items[0].publishAt = oldAt; await publishingStore().write("state.json", state);
  await expect(confirmPublishingReschedule(alice, plan.id, 1, draft.schedulePreviewId!)).rejects.toMatchObject({ code: "CONFLICT" }); expect((await publishingView(alice)).jobs.map(job => job.spec.originalPublishAt)).toEqual(jobs.map(job => job.spec.originalPublishAt));
});

/** 单条改期与整批一致：新时间保存后，本地暂停必须等用户显式继续。 */
it.each([false, true])("keeps a single-job reschedule paused while pause acknowledgement is %s", async acknowledged => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  const paused = await changePublishingJob(alice, job.spec.id, "pause");
  if (acknowledged) await reportPublishing("pc", [{ id: job.spec.id, revision: paused.spec.revision, sequence: 1, state: "paused", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const at = "2026-10-04T19:00:00Z"; const changed = await changePublishingJob(alice, job.spec.id, "reschedule", at);
  expect(changed.spec).toMatchObject({ id: job.spec.id, revision: paused.spec.revision + 1, desired: "pause", originalPublishAt: at, scheduleSource: "manual" });
  expect(changed.initialPublishAt).toBe(job.initialPublishAt);
  const current = (await publishingView(alice)).plans.find(value => value.id === plan.id)!;
  expect(current.items.find(item => item.packageId === job.spec.contentPackage!.id)).toMatchObject({ publishAt: at, scheduleSource: "manual" });
  expect((await changePublishingJob(alice, job.spec.id, "resume")).spec.desired).toBe("run");
});

/** 拒绝 Agent 已明确不会应用的改期，事务不能改写时间、修订或 Plan，仍保留原视频关联。 */
it.each(["needs_attention", "failed", "cancelling"] as const)("rejects a single-job reschedule in %s without mutating the plan or task", async state => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true);
  if (state === "cancelling") await changePublishingJob(alice, job.spec.id, "cancel");
  else await reportPublishing("pc", [{ id: job.spec.id, revision: job.spec.revision, sequence: 1, state, videoId: "existing_video", offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const before = await publishingView(alice);
  await expect(changePublishingJob(alice, job.spec.id, "reschedule", "2026-10-04T19:00:00Z")).rejects.toMatchObject({ code: state === "failed" ? "TERMINAL" : "RESCHEDULE_BLOCKED" });
  const after = await publishingView(alice);
  expect(after.jobs.find(value => value.spec.id === job.spec.id)).toEqual(before.jobs.find(value => value.spec.id === job.spec.id));
  expect(after.plans.find(value => value.id === plan.id)).toEqual(before.plans.find(value => value.id === plan.id));
});

it("shows a completed Job at its actual time when a late reschedule was rejected", async () => {
  const plan = await preview(); const [job] = await confirmPublishingPlan(alice, plan.id, 1, false, true); const actual = job.spec.originalPublishAt!;
  const changed = await changePublishingJob(alice, job.spec.id, "reschedule", "2026-10-04T19:00:00Z");
  await reportPublishing("pc", [{ id: job.spec.id, revision: changed.spec.revision, sequence: 1, state: "published", observedPrivacy: "public", effectivePublishAt: actual, offset: 0, total: job.spec.asset.size, updatedAt: Date.now() }]);
  const current = (await publishingView(alice)).plans.find(value => value.id === plan.id)!; const draft = await previewPublishingReschedule(alice, plan.id, current.revision, rule); expect(draft.scheduleLockedPackageIds).toContain(plan.items[0].packageId); expect(draft.items[0].publishAt).toBe(actual);
});

/** 连续单条改期的中间时刻仍可能在远端请求中；旧修订回读不能提前释放占位。 */
it("retains every single-job reschedule time until the latest revision is acknowledged", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const first = jobs[0];
  const a = first.spec.originalPublishAt!; const b = "2026-10-03T17:00:00Z"; const c = "2026-10-04T17:00:00Z";
  await reportPublishing("pc", [{ id: first.spec.id, revision: first.spec.revision, sequence: 1, state: "scheduled", effectivePublishAt: a, offset: 0, total: first.spec.asset.size, updatedAt: Date.now() }]);
  const revisionB = await changePublishingJob(alice, first.spec.id, "reschedule", b); const revisionC = await changePublishingJob(alice, first.spec.id, "reschedule", c);
  await expect(changePublishingJob(alice, jobs[1].spec.id, "reschedule", b)).rejects.toMatchObject({ code: "DUPLICATE" });
  let current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([a, b, c].map(Date.parse)));
  await reportPublishing("pc", [{ id: first.spec.id, revision: revisionB.spec.revision, sequence: 2, state: "scheduled", effectivePublishAt: b, offset: 0, total: first.spec.asset.size, updatedAt: Date.now() }]);
  current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([a, b, c].map(Date.parse)));
  const currentPlan = (await publishingView(alice)).plans.find(value => value.id === plan.id)!;
  await expect(previewPublishingReschedule(alice, plan.id, currentPlan.revision, rule, currentPlan.items.map((item, index) => index === 1 ? { ...item, scheduleSource: "manual", publishAt: b } : item))).rejects.toMatchObject({ code: "CONFLICT" });
  await reportPublishing("pc", [{ id: first.spec.id, revision: revisionC.spec.revision, sequence: 3, state: "scheduled", effectivePublishAt: c, offset: 0, total: first.spec.asset.size, updatedAt: Date.now() }]);
  current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([Date.parse(c)])); expect(current.pendingPublishAt).toBeUndefined(); expect(current.pendingPublishAts).toBeUndefined();
  await expect(changePublishingJob(alice, jobs[1].spec.id, "reschedule", b)).resolves.toMatchObject({ spec: { originalPublishAt: b } });
});

/** 两次整批改期保留各任务可能已经发出的中间时刻，最新排期确认后才能交给其他包。 */
it("retains intermediate confirmed-plan slots across multiple unapplied revisions", async () => {
  const plan = await preview(); const jobs = await confirmPublishingPlan(alice, plan.id, 1, false, true); const first = jobs[0]; const a = first.spec.originalPublishAt!;
  const ruleB = { ...rule, weeklySlots: [{ weekday: 6, time: "17:00" }] }; const ruleC = { ...rule, weeklySlots: [{ weekday: 7, time: "17:00" }] };
  const previewB = await previewPublishingReschedule(alice, plan.id, plan.revision, ruleB); const committedB = await confirmPublishingReschedule(alice, plan.id, plan.revision, previewB.schedulePreviewId!); const b = committedB.items[0].publishAt!;
  const revisionB = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!.spec.revision;
  const previewC = await previewPublishingReschedule(alice, plan.id, committedB.revision, ruleC); const committedC = await confirmPublishingReschedule(alice, plan.id, committedB.revision, previewC.schedulePreviewId!); const c = committedC.items[0].publishAt!;
  let current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([a, b, c].map(Date.parse)));
  await reportPublishing("pc", [{ id: first.spec.id, revision: revisionB, sequence: 1, state: "scheduled", effectivePublishAt: b, offset: 0, total: first.spec.asset.size, updatedAt: Date.now() }]);
  current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one").has(Date.parse(b))).toBe(true);
  await expect(previewPublishingReschedule(alice, plan.id, committedC.revision, ruleC, committedC.items.map((item, index) => index === 1 ? { ...item, scheduleSource: "manual", publishAt: b } : item))).rejects.toMatchObject({ code: "CONFLICT" });
  await reportPublishing("pc", [{ id: first.spec.id, revision: current.spec.revision, sequence: 2, state: "scheduled", effectivePublishAt: c, offset: 0, total: first.spec.asset.size, updatedAt: Date.now() }]);
  current = (await publishingView(alice)).jobs.find(job => job.spec.id === first.spec.id)!; expect(occupiedPublishingSlots([current], "channel_one")).toEqual(new Set([Date.parse(c)]));
  const released = await previewPublishingReschedule(alice, plan.id, committedC.revision, ruleC, committedC.items.map((item, index) => index === 1 ? { ...item, scheduleSource: "manual", publishAt: b } : item)); expect(released.items[1].publishAt).toBe(b);
});
