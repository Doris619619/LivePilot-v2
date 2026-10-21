/** 连续发布修复的版本准入与旧错配恢复；真实Cloud/Runner和加密检查点，仅外部VideoPort为合成响应。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { acceptPublishingPrivacy, changePublishingJob, publishingStore, publishingTick, publishingView, reportPublishing, savePublishingPolicy } from "@/cloud/publishing";
import { pollTasks, reportTasks } from "@/cloud/tasks";
import { createPublishingAccount, claimPublishingAccount } from "@/cloud/publishing-accounts";
import { config } from "@/core/config";
import { AppError } from "@/core/errors";
import type { Service } from "@/core/service";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
import { YouTubeAuth } from "@/core/youtube/auth";
import { VideoApi, VideoApiError } from "@/core/youtube/video-api";
import { seal, unseal, Store } from "@/core/storage";
import { defaultPolicy, PRIVACY_VERSION, type VideoJob } from "@/shared/publishing";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";
import { seedTestYouTubeBaseline } from "./youtube-usage-baseline";

const alice = { username: "alice", role: "customer" as const }, admin = { username: "admin", role: "admin" as const };
let root: string;
const runners: PublishingRunner[] = [];
/** 每例独立设备、访问身份和媒体目录，禁止任何真实网络动作。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-repair-overlap-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", path.join(root, "media")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main");
  const { accessStore, emptyAccess } = await import("@/server/access"); const access = emptyAccess(); access.users.push({ ...alice, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }); await accessStore().write("access.json", access);
  const pair = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", pair.code, "b".repeat(64)); const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc", session.session, []);
  await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-consent-v2", "publishing-recovery-v1", "publishing-accounts-v1"]); await cloudStore().write("bindings.json", [{ agentId: "pc", instanceId: "main", channelId: "channel_one", confirmed: true }]);
  await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true }); await acceptPublishingPrivacy(alice, PRIVACY_VERSION); await seedTestYouTubeBaseline();
  const thumbnails = path.join(config("main").mediaRoot, "thumbnails"); await mkdir(thumbnails, { recursive: true }); for (const filename of ["old.jpg", "first.jpg", "second.jpg"]) await writeFile(path.join(thumbnails, filename), Buffer.from("ffd8ffe000000000", "hex"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external request"); }));
});
/** 即使断言失败也先排空Runner，再恢复环境并删除本例精确临时目录。 */
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.stop())); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-repair-overlap-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true });
});
/** 固定原视频与已完成旧封面；之后所有修复/取消/核对均走真实Cloud。 */
async function scenario(options: { generation?: () => Promise<string | undefined>; auth?: YouTubeAuth } = {}) {
  const spec = fixtureJob(); spec.profile.thumbnailMode = "fixed"; spec.profile.thumbnailFilename = "old.jpg";
  if (options.generation) { await cloudStore().write("bindings.json", []); const account = await createPublishingAccount(alice, "pc", "main", "Synthetic"); await claimPublishingAccount("pc", account.id, "main", "channel_one", undefined, true); spec.profile.accountId = account.id; }
  const report = { id: spec.id, revision: 1, sequence: 1, state: "needs_attention" as const, offset: spec.asset.size, total: spec.asset.size, videoId: "video_one", updatedAt: Date.now(), metadata: { title: "Synthetic", description: "Synthetic" } };
  const saved = (await publishingStore().read<{ jobs: VideoJob[] }>("state.json"))!; saved.jobs.push({ spec, observed: report, hadUpload: true, createdAt: Date.now() }); await publishingStore().write("state.json", saved);
  const storage = new PublishingStore(path.join(root, "checkpoint")); await storage.write("entries.enc", seal([{ spec, report, thumbnailDone: true, playlistsDone: [], failures: 1 }]));
  const { api, videos } = fixtureApi(); videos.set("video_one", { id: "video_one", snippet: { channelId: spec.profile.channelId }, status: { privacyStatus: "private", uploadStatus: "processed" }, processingDetails: { processingStatus: "succeeded" } });
  /** 重建只读取真实持久检查点，不通过内存复制伪造重启。 */
  const restart = () => { const services = options.auth ? new Map([["main", { auth: options.auth } as Service]]) : new Map<string, Service>(); const runner = new PublishingRunner(services, { store: storage, api: () => api, accountAuthorizationGeneration: options.generation }); runners.push(runner); return runner; };
  return { spec, storage, api, restart, runner: restart() };
}
/** 仅等待实际异步步骤排空，不用固定延迟表达执行成功。 */
async function idle(runner: PublishingRunner) { await vi.waitFor(() => expect(runner.busy).toBe(false), { timeout: 3000, interval: 25 }); }
/** 用户修复只修改合法封面/播放列表字段。 */
function repair(id: string, thumbnailFilename: string, playlistIds: string[] = []) { return changePublishingJob(alice, id, "repair", undefined, { thumbnailMode: "fixed", thumbnailFilename, playlistIds }); }

/** 旧版Cloud曾受理但设备拒收的第二份修复；用于恢复已有坏数据，不通过新接口制造不存在的合法路径。 */
async function legacyMismatch(id: string) {
  const state = (await publishingStore().read<{ jobs: VideoJob[] }>("state.json"))!; const job = state.jobs.find(job => job.spec.id === id)!;
  job.spec = { ...job.spec, revision: job.spec.revision + 1, repairRevision: job.spec.revision + 1, profile: { ...job.spec.profile, thumbnailFilename: "second.jpg", playlistIds: ["second_playlist"] } }; await publishingStore().write("state.json", state); return structuredClone(job.spec);
}
/** 运行真实Scheduler派发和任务接受/完成回报，确认最终控制确实到达Runner，不止检查API受理。 */
async function deliverLatest(runner: PublishingRunner, id: string) {
  await publishingTick(); const job = (await publishingView(alice)).jobs.find(job => job.spec.id === id)!;
  const task = (await pollTasks("pc")).find(task => task.payload.kind === "publishing-apply" && task.payload.job.id === id && task.payload.job.revision === job.spec.revision)!; expect(task).toBeDefined();
  await reportTasks("pc", [{ id: task.id, status: "running" }]); if (task.payload.kind !== "publishing-apply") throw new Error("Unexpected synthetic task"); await runner.apply(task.payload.job); await reportTasks("pc", [{ id: task.id, status: "succeeded", result: { ok: true } }]);
}

it.each(["success", "failure"] as const)("R04 blocks the next repair until the first %s is reported and still executes the last cancellation", async outcome => {
  const { spec, runner, api, restart } = await scenario(); if (outcome === "failure") api.playlist.mockRejectedValueOnce(new VideoApiError("PLAYLIST", "Synthetic failed first repair"));
  const first = await repair(spec.id, "first.jpg", ["first_playlist"]); await runner.apply(first.spec);
  await expect(repair(spec.id, "second.jpg")).rejects.toMatchObject({ code: "REPAIR_PENDING" }); await runner.tick(); await idle(runner); const delayed = await runner.reports();
  expect(delayed[0].state).toBe(outcome === "success" ? "completed" : "needs_attention"); await expect(repair(spec.id, "second.jpg")).rejects.toMatchObject({ code: "REPAIR_PENDING" });
  const cancel = await changePublishingJob(alice, spec.id, "cancel"); await reportPublishing("pc", delayed); expect(cancel.spec.profile.thumbnailFilename).toBe("first.jpg");
  await runner.stop(); const recovered = restart(); await deliverLatest(recovered, spec.id); await recovered.tick(); await idle(recovered); await reportPublishing("pc", await recovered.reports());
  expect(api.unschedule).toHaveBeenCalledExactlyOnceWith("video_one"); expect(api.begin).not.toHaveBeenCalled(); expect((await publishingView(alice)).jobs[0]).toMatchObject({ spec: { desired: "cancel" }, observed: { state: "cancelled", revision: cancel.spec.revision, videoId: "video_one" } });
  await reportPublishing("pc", delayed); expect((await publishingView(alice)).jobs[0].observed?.state).toBe("cancelled");
});

it("R04 serializes two tabs and allows a second repair only after the first current failure is acknowledged", async () => {
  const { spec, runner, api } = await scenario(); const results = await Promise.allSettled([repair(spec.id, "first.jpg", ["first_playlist"]), repair(spec.id, "second.jpg", ["second_playlist"])]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "REPAIR_PENDING" } });
  const first = (await publishingView(alice)).jobs[0]; api.playlist.mockRejectedValueOnce(new VideoApiError("PLAYLIST", "Synthetic failure")); await runner.apply(first.spec); await runner.tick(); await idle(runner); await reportPublishing("pc", await runner.reports());
  const second = await repair(spec.id, first.spec.profile.thumbnailFilename === "first.jpg" ? "second.jpg" : "first.jpg", ["replacement_playlist"]); await runner.apply(second.spec); await runner.tick(); await idle(runner); await reportPublishing("pc", await runner.reports());
  expect((await publishingView(alice)).jobs[0].observed).toMatchObject({ revision: second.spec.revision, state: "completed", videoId: "video_one" }); expect(api.thumbnail).toHaveBeenCalledTimes(2); expect(api.playlist).toHaveBeenLastCalledWith("video_one", "replacement_playlist"); expect(api.begin).not.toHaveBeenCalled();
});

it.each(["success-cancel", "failure-cancel", "success-reconcile", "failure-reconcile"] as const)("R04 recovers an existing %s profile mismatch and actually cancels the original video", async flow => {
  const { spec, runner, api, restart } = await scenario(); if (flow.startsWith("failure")) api.playlist.mockRejectedValueOnce(new VideoApiError("PLAYLIST", "Synthetic old repair failure"));
  const first = await repair(spec.id, "first.jpg", ["first_playlist"]); await runner.apply(first.spec); await legacyMismatch(spec.id); await runner.tick(); await idle(runner); const delayed = await runner.reports(); await reportPublishing("pc", delayed);
  await runner.stop(); const recovered = restart();
  if (flow.endsWith("reconcile")) {
    await changePublishingJob(alice, spec.id, "reconcile"); await deliverLatest(recovered, spec.id); await recovered.tick(); await idle(recovered); await reportPublishing("pc", await recovered.reports());
    expect((await publishingView(alice)).jobs[0].observed).toMatchObject({ state: "needs_attention", videoId: "video_one" }); expect(api.thumbnail).toHaveBeenCalledTimes(1); expect(api.unschedule).not.toHaveBeenCalled();
  }
  const cancel = await changePublishingJob(alice, spec.id, "cancel");
  for (const altered of [ { owner: "other" }, { batchId: randomUUID() }, { asset: { ...cancel.spec.asset, version: "e".repeat(64) } }, { profile: { ...cancel.spec.profile, channelId: "wrong_channel" } }, { profile: { ...cancel.spec.profile, accountId: randomUUID() } }, { profile: { ...cancel.spec.profile, instanceId: "another" } } ]) await expect(recovered.apply({ ...cancel.spec, ...altered })).rejects.toMatchObject({ code: "REQUEST" });
  await deliverLatest(recovered, spec.id); await recovered.tick(); await idle(recovered); await reportPublishing("pc", await recovered.reports()); await reportPublishing("pc", delayed);
  const current = (await publishingView(alice)).jobs[0]; expect(current.observed).toMatchObject({ state: "cancelled", revision: cancel.spec.revision, videoId: "video_one" }); expect(api.unschedule).toHaveBeenCalledExactlyOnceWith("video_one"); expect(api.thumbnail).toHaveBeenCalledTimes(1); expect(api.begin).not.toHaveBeenCalled();
});

it.each(["success", "failure"] as const)("R04 an in-flight first thumbnail %s cannot clear the next repair pending work", async outcome => {
  const { spec, runner, api } = await scenario(); const pending = Promise.withResolvers<void>(); api.thumbnail.mockImplementationOnce(() => pending.promise);
  const first = await repair(spec.id, "first.jpg"); await runner.apply(first.spec); await runner.tick();
  try {
    await vi.waitFor(() => expect(api.thumbnail).toHaveBeenCalledOnce()); const legacy = await legacyMismatch(spec.id); const query = await changePublishingJob(alice, spec.id, "reconcile"); expect(query.spec.revision).toBe(legacy.revision + 1); await runner.apply(query.spec);
    if (outcome === "success") pending.resolve(); else pending.reject(new VideoApiError("THUMBNAIL", "Synthetic stale thumbnail failure")); await idle(runner); await runner.tick(); await idle(runner); await reportPublishing("pc", await runner.reports());
    expect((await runner.reports())[0]).toMatchObject({ state: "needs_attention", revision: query.spec.revision }); const resume = await changePublishingJob(alice, spec.id, "resume"); await runner.apply(resume.spec); await runner.tick(); await idle(runner);
    expect(api.thumbnail).toHaveBeenCalledTimes(2); expect(api.thumbnail).toHaveBeenLastCalledWith("video_one", expect.stringMatching(/second\.jpg$/)); expect((await runner.reports())[0].state).toBe("completed"); expect(api.begin).not.toHaveBeenCalled();
  } finally { pending.resolve(); await idle(runner); }
});

it.each(["generation", "channel", "repair-read"] as const)("R04 an old execution blocked at %s cannot turn read-only reconciliation into a repair", async stage => {
  const pending = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const auth = new YouTubeAuth(new Store(path.join(root, "synthetic-auth"))); await new Store(path.join(root, "synthetic-auth")).write("youtube.enc", seal({ channelId: "channel_one", accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Date.now() + 3600_000 }));
  const generation = vi.fn(async () => { entered.resolve(); await pending.promise; return "synthetic-generation"; });
  if (stage === "channel") { const tokens = auth.tokens.bind(auth); vi.spyOn(auth, "tokens").mockImplementationOnce(async () => { entered.resolve(); await pending.promise; return tokens(); }); }
  const { spec, runner, api } = await scenario({ ...(stage === "generation" ? { generation } : {}), ...(stage === "channel" ? { auth } : {}) });
  if (stage === "repair-read") { const list = api.list.getMockImplementation()!; api.list.mockImplementationOnce(async ids => { entered.resolve(); await pending.promise; return list(ids); }); }
  const first = await repair(spec.id, "first.jpg"); await runner.apply(first.spec); await runner.tick();
  try {
    await entered.promise; await legacyMismatch(spec.id); const query = await changePublishingJob(alice, spec.id, "reconcile"); await runner.apply(query.spec); pending.resolve(); await idle(runner); await runner.tick(); await idle(runner); await reportPublishing("pc", await runner.reports());
    expect(api.thumbnail).not.toHaveBeenCalled(); expect(api.playlist).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); expect((await runner.reports())[0]).toMatchObject({ revision: query.spec.revision, state: "needs_attention", videoId: "video_one" });
    const resume = await changePublishingJob(alice, spec.id, "resume"); await runner.apply(resume.spec); await runner.tick(); await idle(runner); expect(api.thumbnail).toHaveBeenCalledExactlyOnceWith("video_one", expect.stringMatching(/second\.jpg$/)); expect((await runner.reports())[0].state).toBe("completed"); expect(api.begin).not.toHaveBeenCalled();
  } finally { pending.resolve(); await idle(runner); }
});

it("R04 still reports a real authorization rejection after a newer read-only revision", async () => {
  const { spec, runner, api } = await scenario(); const pending = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); api.list.mockImplementationOnce(async () => { entered.resolve(); await pending.promise; throw new AppError("YOUTUBE_AUTH", "Synthetic actual authorization rejection", 409); });
  const first = await repair(spec.id, "first.jpg"); await runner.apply(first.spec); await runner.tick();
  try { await entered.promise; await legacyMismatch(spec.id); const query = await changePublishingJob(alice, spec.id, "reconcile"); await runner.apply(query.spec); pending.resolve(); await idle(runner); expect((await runner.reports())[0]).toMatchObject({ revision: query.spec.revision, state: "needs_attention", authorizationInvalid: true, videoId: "video_one" }); expect(api.thumbnail).not.toHaveBeenCalled(); }
  finally { pending.resolve(); await idle(runner); }
});

it("R04 a pending checkpoint write cannot let an old execution take over a read-only repair revision", async () => {
  const { spec, runner, api, storage } = await scenario(); const first = await repair(spec.id, "first.jpg"); await runner.apply(first.spec);
  const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); const write = storage.write.bind(storage); let held = false; let applying = Promise.resolve({ ok: true });
  vi.spyOn(storage, "write").mockImplementation(async (name, value) => {
    if (!held && name === "entries.enc" && unseal<{ repairPending?: boolean }[]>(value as string)[0].repairPending === false) { held = true; entered.resolve(); await pending.promise; }
    return write(name, value);
  });
  await runner.tick();
  try {
    await entered.promise; await legacyMismatch(spec.id); const query = await changePublishingJob(alice, spec.id, "reconcile"); applying = runner.apply(query.spec);
    await vi.waitFor(async () => expect((await runner.reports())[0].revision).toBe(query.spec.revision)); pending.resolve(); await applying; await idle(runner); await runner.tick(); await idle(runner); await reportPublishing("pc", await runner.reports());
    expect(api.thumbnail).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); expect((await runner.reports())[0].state).toBe("needs_attention"); const resume = await changePublishingJob(alice, spec.id, "resume"); await runner.apply(resume.spec); await runner.tick(); await idle(runner); expect(api.thumbnail).toHaveBeenCalledExactlyOnceWith("video_one", expect.stringMatching(/second\.jpg$/));
  } finally { pending.resolve(); await applying; await idle(runner); }
});

it.each(["authorization", "ordinary"] as const)("R04 an in-flight real finalize %s rejection keeps only the actual credential failure after reconciliation", async outcome => {
  const { spec, runner, api } = await scenario(); const storage = new Store(path.join(root, "actual-finalize-auth")), generation = randomUUID();
  await storage.write("youtube.enc", seal({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", authorizationGeneration: generation, expiresAt: Date.now() + 3600_000, channelId: "channel_one", channel: "Synthetic" }));
  const actual = new VideoApi(new YouTubeAuth(storage)); api.finalize.mockImplementation((...args) => actual.finalize(...args));
  const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (init?.method === "PUT") { entered.resolve(); await pending.promise; return Response.json({}, { status: outcome === "authorization" ? 401 : 400 }); }
    return Response.json({ items: [{ id: "video_one", etag: "synthetic-etag", snippet: { channelId: "channel_one" }, status: { privacyStatus: "private" } }] });
  }); vi.stubGlobal("fetch", fetcher);
  const first = await repair(spec.id, "first.jpg"); await runner.apply(first.spec); await runner.tick();
  try {
    await entered.promise; await legacyMismatch(spec.id); const query = await changePublishingJob(alice, spec.id, "reconcile"); await runner.apply(query.spec); pending.resolve(); await idle(runner);
    const report = (await runner.reports())[0]; expect(report).toMatchObject({ revision: query.spec.revision, state: "needs_attention", videoId: "video_one" });
    if (outcome === "authorization") expect(report).toMatchObject({ authorizationInvalid: true, authorizationGeneration: generation, authorizationFailureId: expect.any(String) });
    else { expect(report.authorizationInvalid).toBeUndefined(); expect(report.message).not.toContain("YouTube 未接受"); }
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1); expect(api.begin).not.toHaveBeenCalled();
  } finally { pending.resolve(); await idle(runner); }
});
