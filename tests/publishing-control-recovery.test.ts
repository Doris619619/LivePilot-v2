/** 发布控制交错回归：真实Cloud事务、统一准入和Runner检查点；Google及文案仅使用合成替身。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { acceptPublishingPrivacy, changePublishingJob, publishingStore, publishingView, removePublishingBatch, reportPublishing, savePublishingPolicy } from "@/cloud/publishing";
import { admitYouTube } from "@/cloud/youtube-usage";
import { agentPublishingAccounts, claimPublishingAccount, completePublishingReauthorization, createPublishingAccount, publishingReauthorizationEpoch } from "@/cloud/publishing-accounts";
import { config } from "@/core/config";
import { PublishingRunner } from "@/core/publishing/runner";
import { scanPublishingAssets } from "@/core/publishing/assets";
import { PublishingStore } from "@/core/publishing/storage";
import { seal } from "@/core/storage";
import type { YouTubeAuth } from "@/core/youtube/auth";
import { VideoApi, VideoApiError } from "@/core/youtube/video-api";
import { installYouTubeRuntime } from "@/core/youtube/usage";
import { accessStore, emptyAccess } from "@/server/access";
import { defaultPolicy, PRIVACY_VERSION, type JobSpec, type PublishingReport, type VideoJob } from "@/shared/publishing";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";
import { seedTestYouTubeBaseline } from "./youtube-usage-baseline";

const alice = { username: "alice", role: "customer" as const }, admin = { username: "admin", role: "admin" as const };
const fingerprint = createHash("sha256").update("synthetic-control-client").digest("hex");
let root: string;
const runners: PublishingRunner[] = [];
/** 每例使用独立真实文件状态；默认禁止任何意外出站。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-control-recovery-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", path.join(root, "media")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-control-client");
  const access = emptyAccess(); access.users.push({ ...alice, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }); await accessStore().write("access.json", access);
  const pair = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", pair.code, "b".repeat(64));
  const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []);
  await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-recovery-v1", "publishing-accounts-v1", "publishing-auth-generation-v1"]);
  await cloudStore().write("bindings.json", [{ agentId: "pc", instanceId: "main", channelId: "channel_one", confirmed: true }]);
  await savePublishingPolicy(admin, defaultPolicy); await acceptPublishingPrivacy(alice, PRIVACY_VERSION); await seedTestYouTubeBaseline();
  installYouTubeRuntime({ admit: input => admitYouTube("pc", { ...input, clientFingerprint: fingerprint }), record: async () => {} });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external request"); }));
});
/** 所有Runner完成后才恢复全局环境，断言失败也不能泄漏后台工作。 */
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.stop())); installYouTubeRuntime(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-control-recovery-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
});
/** 只注入已经确认的任务夹具；之后控制、删除和上报均走真实Cloud写事务。 */
async function seedJob(spec: JobSpec, state: PublishingReport["state"] = "needs_attention") {
  const job: VideoJob = { spec, createdAt: Date.now(), hadUpload: true, observed: { id: spec.id, revision: spec.revision, sequence: 1, state, offset: spec.asset.size, total: spec.asset.size, videoId: "video_one", updatedAt: Date.now() } };
  const saved = (await publishingStore().read<{ jobs: VideoJob[] }>("state.json"))!; saved.jobs.push(job); await publishingStore().write("state.json", saved); return job;
}
/** 固定原视频和错误检查点，不依赖真实平台上传。 */
async function checkpoint(spec: JobSpec, state: PublishingReport["state"] = "needs_attention") {
  const store = new PublishingStore(path.join(root, randomUUID()));
  await store.write("entries.enc", seal([{ spec, report: { id: spec.id, revision: spec.revision, sequence: 1, state, offset: spec.asset.size, total: spec.asset.size, videoId: "video_one", updatedAt: Date.now(), metadata: { title: "Synthetic", description: "Synthetic" } }, playlistsDone: [], failures: 0 }])); return store;
}
/** 注册Runner使失败路径也能停止并落盘；真实API端口可按场景注入。 */
function track(runner: PublishingRunner) { runners.push(runner); return runner; }
/** 只等待实际短阶段完成；无任意固定延时。 */
async function idle(runner: PublishingRunner) { await vi.waitFor(() => expect(runner.busy).toBe(false), { timeout: 3000, interval: 25 }); }

it.each(["resume", "cancel", "reconcile", "batch-remove"] as const)("M06 retains an undelivered repair through %s without replacing the source", async action => {
  const original = fixtureJob(); original.profile.playlistIds = ["deleted_playlist"]; await seedJob(original);
  const { api, videos } = fixtureApi(); videos.set("video_one", { id: "video_one", snippet: { channelId: original.profile.channelId }, status: { privacyStatus: "private", uploadStatus: "processed" }, processingDetails: { processingStatus: "succeeded" } });
  const runner = track(new PublishingRunner(new Map(), { store: await checkpoint(original), api: () => api }));
  const repair = await changePublishingJob(alice, original.id, "repair", undefined, { playlistIds: ["valid_playlist"], thumbnailMode: "none" });
  if (action === "batch-remove") await removePublishingBatch(alice, original.batchId);
  const latest = action === "batch-remove" ? (await publishingView(alice)).jobs[0] : await changePublishingJob(alice, original.id, action); expect(repair.spec.repairRevision).toBe(2); expect(latest.spec.repairRevision).toBe(3);
  await expect(runner.apply({ ...latest.spec, profile: { ...latest.spec.profile, channelId: "wrong_channel" } })).rejects.toMatchObject({ code: "REQUEST" });
  await expect(runner.apply({ ...latest.spec, asset: { ...latest.spec.asset, version: "e".repeat(64) } })).rejects.toMatchObject({ code: "REQUEST" });
  await runner.apply(latest.spec); await runner.apply(latest.spec); await runner.tick(); await idle(runner);
  expect((await runner.reports())[0]).toMatchObject({ revision: 3, videoId: "video_one" }); expect(api.begin).not.toHaveBeenCalled();
  if (action === "cancel" || action === "batch-remove") { expect(api.unschedule).toHaveBeenCalledWith("video_one"); expect(api.playlist).not.toHaveBeenCalled(); }
  if (action === "reconcile") expect(api.finalize).not.toHaveBeenCalled();
  if (action === "resume") expect(api.playlist).toHaveBeenCalledWith("video_one", "valid_playlist");
});

it("M04 persists upload ownership only after an allowed admission and blocks a later paused intent", async () => {
  const spec = fixtureJob(); const state = (await publishingStore().read<{ jobs: VideoJob[] }>("state.json"))!; state.jobs.push({ spec, createdAt: Date.now() }); await publishingStore().write("state.json", state);
  const input = { clientFingerprint: fingerprint, instanceId: "main", jobId: spec.id, method: "videos.insert" as const, purpose: "publishing" as const, trigger: "publishing-tick" as const };
  expect((await admitYouTube("pc", { ...input, clientFingerprint: "d".repeat(64), attemptId: randomUUID() })).allowed).toBe(false); expect((await publishingView(alice)).jobs[0].hadUpload).toBeUndefined();
  expect((await admitYouTube("pc", { ...input, attemptId: randomUUID() })).allowed).toBe(true); expect((await publishingView(alice)).jobs[0].hadUpload).toBe(true);
  await changePublishingJob(alice, spec.id, "pause"); await expect(admitYouTube("pc", { ...input, attemptId: randomUUID() })).rejects.toMatchObject({ code: "PUBLISHING_INTENT" });
});

it.each(["success", "failure"] as const)("M13 discards a late ordinary poll %s after cancellation", async result => {
  let now = Date.now(); const original = fixtureJob(); original.profile.scheduled = true; original.profile.privacy = "public"; original.originalPublishAt = new Date(now + 30_000).toISOString();
  const { api } = fixtureApi(); const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.list>>>(); api.list.mockImplementationOnce(() => pending.promise);
  const runner = track(new PublishingRunner(new Map(), { store: await checkpoint(original, "scheduled"), api: () => api, now: () => now }));
  const polling = runner.tick(); await vi.waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  await runner.apply({ ...original, revision: 2, desired: "cancel" });
  if (result === "success") pending.resolve([{ id: "video_one", status: { privacyStatus: "private", publishAt: original.originalPublishAt } }]); else pending.reject(new Error("Synthetic stale failure"));
  await polling; expect((await runner.reports())[0]).toMatchObject({ revision: 2 }); expect((await runner.reports())[0].nextAttemptAt).toBeUndefined();
  now += 40_000; await runner.tick(); await idle(runner); expect(api.unschedule).toHaveBeenCalledWith("video_one"); expect((await runner.reports())[0].state).toBe("cancelled");
});

it("M04 blocks begin after Cloud deletion while the old Runner is awaiting metadata", async () => {
  const media = config("main").mediaRoot; await mkdir(path.join(media, "videos"), { recursive: true }); await writeFile(path.join(media, "videos", "movie.mp4"), "Synthetic video bytes");
  const { assets: [asset] } = await scanPublishingAssets(media); const spec = fixtureJob(asset); await seedJob(spec, "ready");
  const metadata = Promise.withResolvers<{ copy: { title: string; description: string }; source: "template" }>(); const entered = vi.fn();
  const auth = { access: async () => ({ accessToken: "synthetic" }) } as unknown as YouTubeAuth;
  const runner = track(new PublishingRunner(new Map(), { store: new PublishingStore(path.join(root, "active")), api: current => new VideoApi(auth, undefined, { jobId: current.id }), metadata: async () => { entered(); return metadata.promise; } }));
  await runner.apply(spec); await runner.tick(); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  await removePublishingBatch(alice, spec.batchId); expect(fetch).not.toHaveBeenCalled(); metadata.resolve({ copy: { title: "Synthetic", description: "Synthetic" }, source: "template" }); await idle(runner);
  expect(fetch).not.toHaveBeenCalled(); const current = (await publishingView(alice)).jobs[0]; expect(current.spec.desired).toBe("cancel");
  for (const method of ["videos.list", "videos.upload.probe", "videos.update"] as const) expect((await admitYouTube("pc", { attemptId: randomUUID(), clientFingerprint: fingerprint, instanceId: "main", jobId: spec.id, method, purpose: "publishing", trigger: "publishing-tick" })).allowed).toBe(true);
  await runner.apply(current.spec); await runner.tick(); await idle(runner); expect((await runner.reports())[0].state).toBe("cancelled");
  await reportPublishing("pc", await runner.reports()); expect((await publishingView(alice)).removals[0].completedAt).toBeDefined();
});

it.each(["resume", "pause", "cancel", "reconcile"] as const)("M05 %s clears historical failure, ignores a peer's late old credentials, and preserves fresh 401", async action => {
  const account = await createPublishingAccount(alice, "pc", "main", "Synthetic recovery"); await claimPublishingAccount("pc", account.id, "main", "channel_one", "Synthetic", true, Date.now());
  const oldGeneration = randomUUID(), generation = randomUUID();
  await completePublishingReauthorization("pc", account.id, await publishingReauthorizationEpoch("pc", account.id), oldGeneration);
  const spec = fixtureJob(); spec.profile.accountId = account.id; const job = await seedJob(spec);
  const storage = await checkpoint(spec); const entries = [{ spec, report: { ...job.observed!, sequence: 2, authorizationInvalid: true, authorizationFailureId: randomUUID(), authorizationGeneration: oldGeneration }, playlistsDone: [], failures: 0 }]; await storage.write("entries.enc", seal(entries));
  const { api } = fixtureApi(); api.list.mockRejectedValue(new VideoApiError("YOUTUBE_AUTH", "Synthetic new 401")); api.unschedule.mockRejectedValue(new VideoApiError("YOUTUBE_AUTH", "Synthetic new 401"));
  const runner = track(new PublishingRunner(new Map(), { store: storage, api: () => api, accountAuthorizationGeneration: async () => generation }));
  await reportPublishing("pc", await runner.reports()); expect((await agentPublishingAccounts("pc"))[0].status).toBe("needs_reauthorization");
  await completePublishingReauthorization("pc", account.id, await publishingReauthorizationEpoch("pc", account.id), generation);
  const current = await changePublishingJob(alice, spec.id, action); await runner.apply(current.spec);
  const reports = await runner.reports(); expect(reports[0].authorizationInvalid).toBeUndefined(); await reportPublishing("pc", reports); expect((await agentPublishingAccounts("pc"))[0].status).toBe("connected");
  // 另一个任务在新OAuth前已失败、现在才送达；它没有任何已知sequence，仍须凭旧代次拒绝重新锁号。
  const peer = fixtureJob(); peer.profile.accountId = account.id; await seedJob(peer); await reportPublishing("pc", [{ id: peer.id, revision: 1, sequence: 2, state: "needs_attention", offset: peer.asset.size, total: peer.asset.size, videoId: "video_peer", updatedAt: Date.now(), authorizationInvalid: true, authorizationFailureId: randomUUID(), authorizationGeneration: oldGeneration }]); expect((await agentPublishingAccounts("pc"))[0].status).toBe("connected");
  await runner.tick(); await idle(runner); const [after] = await runner.reports(); expect(after.videoId).toBe("video_one");
  if (action === "pause") { expect(after.state).toBe("paused"); expect(api.list).not.toHaveBeenCalled(); expect(api.unschedule).not.toHaveBeenCalled(); }
  else {
    expect(after).toMatchObject({ authorizationInvalid: true, authorizationGeneration: generation }); expect(after.authorizationFailureId).toEqual(expect.any(String)); await reportPublishing("pc", [after]); expect((await agentPublishingAccounts("pc"))[0].status).toBe("needs_reauthorization");
    const epoch = await publishingReauthorizationEpoch("pc", account.id); await reportPublishing("pc", [{ ...after, sequence: after.sequence + 1 }]); expect(await publishingReauthorizationEpoch("pc", account.id)).toBe(epoch);
  }
});

it.each(["continue", "reconcile-continue", "pause-reconcile-continue"] as const)("V05 %s preserves the pending changed thumbnail across a restart", async flow => {
  const original = fixtureJob(); original.profile.thumbnailMode = "fixed"; original.profile.thumbnailFilename = "old.jpg"; original.profile.playlistIds = ["old_playlist"]; await seedJob(original);
  const media = config("main").mediaRoot; await mkdir(path.join(media, "thumbnails"), { recursive: true }); await writeFile(path.join(media, "thumbnails", "new.jpg"), Buffer.from("ffd8ffe000000000", "hex"));
  const storage = await checkpoint(original); await storage.write("entries.enc", seal([{ spec: original, report: { id: original.id, revision: 1, sequence: 1, state: "needs_attention", offset: original.asset.size, total: original.asset.size, videoId: "video_one", updatedAt: Date.now(), metadata: { title: "Synthetic", description: "Synthetic" } }, thumbnailDone: true, playlistsDone: ["old_playlist"], failures: 1 }]));
  const { api, videos } = fixtureApi(); videos.set("video_one", { id: "video_one", snippet: { channelId: original.profile.channelId }, status: { privacyStatus: "private", uploadStatus: "processed" }, processingDetails: { processingStatus: "succeeded" } });
  let runner = track(new PublishingRunner(new Map(), { store: storage, api: () => api }));
  await changePublishingJob(alice, original.id, "repair", undefined, { thumbnailMode: "fixed", thumbnailFilename: "new.jpg", playlistIds: ["new_playlist"] });
  if (flow !== "continue") {
    if (flow === "pause-reconcile-continue") await changePublishingJob(alice, original.id, "pause");
    const query = await changePublishingJob(alice, original.id, "reconcile"); await runner.apply(query.spec); await runner.tick(); await idle(runner); expect(api.thumbnail).not.toHaveBeenCalled(); expect(api.playlist).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled();
    await reportPublishing("pc", await runner.reports()); await runner.stop(); runner = track(new PublishingRunner(new Map(), { store: storage, api: () => api }));
  }
  const current = await changePublishingJob(alice, original.id, "resume"); await runner.apply(current.spec); await runner.tick(); await idle(runner);
  expect(api.thumbnail).toHaveBeenCalledExactlyOnceWith("video_one", expect.stringMatching(/new\.jpg$/)); expect(api.playlist).toHaveBeenCalledExactlyOnceWith("video_one", "new_playlist"); expect(api.begin).not.toHaveBeenCalled(); expect((await runner.reports())[0]).toMatchObject({ videoId: "video_one", state: "completed" });
});
