/** 排期秒级兼容和旧误报的只读恢复回归；使用加密检查点和合成 API，不操作真实视频。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
import { effectivePublishAt } from "@/core/publishing/schedule";
import { seal, unseal } from "@/core/storage";
import type { JobSpec, PublishingReport } from "@/shared/publishing";
import type { VideoResource } from "@/core/youtube/video-api";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";

let root: string; let store: PublishingStore; let job: JobSpec; let now: number;
const copy = { title: "Persisted title", description: "Persisted description" };
const legacyMessage = "YouTube 排期未确认，请核对 API Audit 和频道设置。";
const candidate = "2026-10-06T12:21:05.501Z";
const remoteAt = "2026-10-06T12:21:05Z";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-schedule-"));
  vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  store = new PublishingStore(path.join(root, "publisher")); now = Date.parse("2026-10-06T12:11:05.501Z");
  job = fixtureJob(); job.profile.privacy = "public"; job.profile.scheduled = true; job.originalPublishAt = "2026-10-06T12:12:00Z";
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-schedule-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
});
/** 仅等待合成后台步骤到达持久检查点，避免真实网络或固定长等待。 */
async function settle(runner: PublishingRunner) { for (let index = 0; index < 500 && runner.busy; index++) await new Promise(resolve => setTimeout(resolve, 5)); expect(runner.busy).toBe(false); }
/** 写入旧版确切精度误报，可逐项破坏证据验证人工修改不会被确认。 */
async function legacyCheckpoint(extra: Record<string, unknown> = {}, report: Partial<PublishingReport> = {}) {
  await store.write("entries.enc", seal([{ spec: job, finalized: false, scheduleRevisionPending: false, reschedulePreviousAt: "2026-10-06T22:00:00Z", resumeState: "finalizing", failures: 1, playlistsDone: [], ...extra, report: { id: job.id, revision: job.revision, sequence: 1, state: "needs_attention", offset: job.asset.size, total: job.asset.size, updatedAt: now, videoId: "v1", effectivePublishAt: candidate, metadata: copy, message: legacyMessage, ...report } }]));
}
/** 创建所有可写字段完全一致的已处理私密视频；只有 publishAt 缺少旧候选毫秒。 */
function matchingVideo(): VideoResource {
  return { id: "v1", snippet: { channelId: job.profile.channelId, ...copy, categoryId: job.profile.categoryId, tags: job.profile.tags }, status: { privacyStatus: "private", publishAt: remoteAt, uploadStatus: "processed", selfDeclaredMadeForKids: job.profile.madeForKids, license: job.profile.license, embeddable: job.profile.embeddable, containsSyntheticMedia: job.profile.containsSyntheticMedia }, processingDetails: { processingStatus: "succeeded" } };
}
/** 用户核对只增加查询修订，不改变原任务排期或执行意图。 */
function requestReconciliation() { return { ...job, revision: job.revision + 1, reconcileRevision: job.revision + 1 }; }

it.each([
  ["2026-10-06T12:12:00Z", 600, "2026-10-06T12:11:05.501Z", "2026-10-06T12:21:06.000Z"],
  ["2026-10-06T13:00:00.501Z", 600, "2026-10-06T12:11:05.501Z", "2026-10-06T13:00:01.000Z"],
  ["2026-10-06T13:00:00Z", 600, "2026-10-06T12:11:05Z", "2026-10-06T13:00:00.000Z"],
] as const)("rounds %s upward to whole seconds without shortening the configured lead", (original, lead, clock, expected) => {
  const actual = effectivePublishAt(original, lead, Date.parse(clock)); expect(actual).toBe(expected); expect(Date.parse(actual)).toBeGreaterThanOrEqual(Date.parse(clock) + lead * 1000); expect(Date.parse(actual) % 1000).toBe(0);
});
it("confirms a near-term schedule when YouTube returns its whole-second timestamp", async () => {
  const { api, videos } = fixtureApi(); await legacyCheckpoint({}, { state: "finalizing", message: undefined, effectivePublishAt: undefined }); videos.set("v1", { id: "v1", status: { privacyStatus: "private" } });
  const finalize = api.finalize.getMockImplementation()!;
  api.finalize.mockImplementationOnce(async (...args) => { await finalize(...args); videos.get("v1")!.status!.publishAt = videos.get("v1")!.status!.publishAt!.replace(".000Z", "Z"); });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); await settle(runner);
  expect(api.finalize.mock.calls[0][3]).toBe("2026-10-06T12:21:06.000Z"); expect((await runner.reports())[0]).toMatchObject({ state: "scheduled", effectivePublishAt: "2026-10-06T12:21:06.000Z" }); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("recovers an old fractional candidate after restart without sending a second metadata write", async () => {
  await legacyCheckpoint({}, { state: "finalizing", message: undefined }); const { api, videos } = fixtureApi(); videos.set("v1", matchingVideo());
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); await settle(runner);
  expect((await runner.reports())[0]).toMatchObject({ state: "scheduled", effectivePublishAt: "2026-10-06T12:21:05.000Z" }); expect(api.finalize).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("only read-only reconciliation repairs a proven legacy millisecond false alarm and keeps the remote timestamp", async () => {
  await legacyCheckpoint(); const { api, videos } = fixtureApi(); videos.set("v1", matchingVideo());
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); expect(api.list).not.toHaveBeenCalled(); expect((await runner.reports())[0].state).toBe("needs_attention");
  await runner.apply(requestReconciliation()); await runner.tick(); await runner.tick();
  expect((await runner.reports())[0]).toMatchObject({ revision: 2, state: "scheduled", effectivePublishAt: "2026-10-06T12:21:05.000Z", observedPrivacy: "private", remoteCheckedAt: now }); expect((await runner.reports())[0].message).toBeUndefined();
  const saved = unseal<{ finalized: boolean; reschedulePreviousAt?: string; failures: number }[]>((await store.read<string>("entries.enc"))!)[0]; expect(saved).toMatchObject({ finalized: true, failures: 0 }); expect(saved.reschedulePreviousAt).toBeUndefined();
  expect(api.list).toHaveBeenCalledExactlyOnceWith(["v1"]); expect(api.finalize).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); expect(api.unschedule).not.toHaveBeenCalled(); await runner.stop();
  const restarted = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await restarted.tick(); expect((await restarted.reports())[0].state).toBe("scheduled"); expect(api.finalize).not.toHaveBeenCalled(); await restarted.stop();
});
it("observes publication after a legacy false alarm without claiming a failed reschedule or restoring the old time", async () => {
  await legacyCheckpoint(); const { api, videos } = fixtureApi(); const video = matchingVideo(); video.status!.privacyStatus = "public"; delete video.status!.publishAt; videos.set("v1", video);
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); await runner.tick();
  expect((await runner.reports())[0]).toMatchObject({ revision: 2, state: "published", observedPrivacy: "public", effectivePublishAt: candidate, message: "视频已公开；此前改期结果未确认。" });
  expect(unseal<{ reschedulePreviousAt?: string }[]>((await store.read<string>("entries.enc"))!)[0].reschedulePreviousAt).toBeUndefined(); expect(api.finalize).not.toHaveBeenCalled(); expect(api.unschedule).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("preserves the previous remote schedule when real pending rescheduling loses to publication", async () => {
  await legacyCheckpoint({ scheduleRevisionPending: true }); const { api, videos } = fixtureApi(); const video = matchingVideo(); video.status!.privacyStatus = "public"; delete video.status!.publishAt; videos.set("v1", video);
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); await runner.tick();
  expect((await runner.reports())[0]).toMatchObject({ state: "published", effectivePublishAt: "2026-10-06T22:00:00Z", message: "视频已公开，改期未应用。" }); expect(api.finalize).not.toHaveBeenCalled(); await runner.stop();
});
it.each(["2026-10-06T12:21:06Z", "2026-10-06T12:21:04Z", "invalid", "2026-10-06 12:21:05", undefined])("preserves attention when the real remote time is %s", async publishAt => {
  await legacyCheckpoint(); const { api, videos } = fixtureApi(); const video = matchingVideo(); video.status!.publishAt = publishAt; videos.set("v1", video);
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); await runner.tick(); expect((await runner.reports())[0].state).toBe("needs_attention"); expect(api.finalize).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it.each(["title", "description", "categoryId", "tags", "selfDeclaredMadeForKids", "license", "embeddable", "containsSyntheticMedia"])("does not repair when Studio changed %s", async field => {
  await legacyCheckpoint(); const { api, videos } = fixtureApi(); const video = matchingVideo();
  if (["title", "description", "categoryId"].includes(field)) video.snippet![field] = "Changed";
  else if (field === "tags") video.snippet!.tags = ["changed"];
  else video.status![field] = field === "license" ? "creativeCommon" : !video.status![field];
  videos.set("v1", video); const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); await runner.tick(); expect((await runner.reports())[0].state).toBe("needs_attention"); expect(api.finalize).not.toHaveBeenCalled(); await runner.stop();
});
it.each(["pending", "paused", "cancel", "other_error", "completed_marker", "missing_metadata", "incomplete_upload", "integer_candidate", "unprocessed", "unlisted", "stale_report_revision", "expired", "missing_thumbnail", "missing_playlist", "other_channel"])("does not restore an unsafe or unrelated checkpoint (%s)", async reason => {
  if (reason === "paused") job.desired = "pause"; if (reason === "cancel") job.desired = "cancel";
  if (reason === "missing_thumbnail") job.profile.thumbnailMode = "matching"; if (reason === "missing_playlist") job.profile.playlistIds = ["PLpending"];
  await legacyCheckpoint(reason === "pending" ? { scheduleRevisionPending: true } : reason === "completed_marker" ? { finalized: true } : reason === "expired" ? { expiredData: true } : {}, reason === "other_error" ? { message: "Another unknown result" } : reason === "missing_metadata" ? { metadata: undefined } : reason === "incomplete_upload" ? { offset: 0 } : reason === "integer_candidate" ? { effectivePublishAt: "2026-10-06T12:21:05.000Z" } : reason === "stale_report_revision" ? { revision: job.revision + 1 } : {});
  const { api, videos } = fixtureApi(); const video = matchingVideo(); if (reason === "unprocessed") { video.processingDetails!.processingStatus = "processing"; video.status!.uploadStatus = "uploaded"; } if (reason === "unlisted") video.status!.privacyStatus = "unlisted";
  if (reason === "other_channel") video.snippet!.channelId = "other_channel";
  videos.set("v1", video); const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); await runner.tick(); expect((await runner.reports())[0].state).toBe("needs_attention"); expect(api.finalize).not.toHaveBeenCalled(); expect(api.unschedule).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it.each(["paused", "needs_attention"] as const)("normalizes old disabled flags on load without resuming %s or rejecting an identical revision", async state => {
  job.policy.enabled = false; job.policy.publicVerified = false; if (state === "paused") job.desired = "pause";
  await legacyCheckpoint({}, { state, message: "Original blocked reason" }); const { api } = fixtureApi();
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.load(); await expect(runner.apply(job)).resolves.toEqual({ ok: true }); await runner.tick();
  expect((await runner.reports())[0]).toMatchObject({ state, message: "Original blocked reason" }); expect(api.list).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); await runner.stop();
});
it("finishes an already uploaded scheduled job with legacy disabled flags without product gate errors", async () => {
  job.policy.enabled = false; job.policy.publicVerified = false;
  await legacyCheckpoint({}, { state: "finalizing", message: undefined, effectivePublishAt: undefined }); const { api, videos } = fixtureApi(); videos.set("v1", { id: "v1", status: { privacyStatus: "private" } });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); await settle(runner);
  expect((await runner.reports())[0]).toMatchObject({ state: "scheduled", effectivePublishAt: "2026-10-06T12:21:06.000Z" }); expect(api.finalize).toHaveBeenCalledOnce(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("discards a delayed matching legacy result when a new timing revision arrives", async () => {
  await legacyCheckpoint(); const { api } = fixtureApi(); let entered!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  api.list.mockImplementationOnce(async () => { entered(); await gate; return [matchingVideo()]; });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); const pending = runner.tick(); await started; await runner.apply({ ...job, revision: 3, originalPublishAt: "2026-10-08T12:00:00Z" }); release(); await pending;
  expect((await runner.reports())[0]).toMatchObject({ revision: 3, state: "needs_attention", message: expect.stringContaining("改期未应用") }); expect(api.finalize).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("discards matching evidence after authorization cleanup removes the checkpoint", async () => {
  await legacyCheckpoint(); const { api } = fixtureApi(); let entered!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  api.list.mockImplementationOnce(async () => { entered(); await gate; return [matchingVideo()]; });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(requestReconciliation()); const pending = runner.tick(); await started; await runner.purge(job.profile.instanceId); release(); await pending;
  expect(await runner.reports()).toEqual([]); expect(api.finalize).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
it("keeps a real readback mismatch as attention without blaming API audit", async () => {
  await legacyCheckpoint({}, { state: "finalizing", message: undefined, effectivePublishAt: undefined }); const { api, videos } = fixtureApi(); videos.set("v1", { id: "v1", status: { privacyStatus: "private" } }); const finalize = api.finalize.getMockImplementation()!;
  api.finalize.mockImplementationOnce(async (...args) => { await finalize(...args); videos.get("v1")!.status!.publishAt = "2026-10-06T12:21:07Z"; });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); await settle(runner); expect((await runner.reports())[0]).toMatchObject({ state: "needs_attention", message: "YouTube 返回的排期与本次设置不一致，请核对视频状态。" }); expect(api.begin).not.toHaveBeenCalled(); await runner.stop();
});
