/** 取消跳过离线期间未送达改期的恢复回归；合成远端端口与临时加密日志不操作真实视频。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
import { seal, unseal } from "@/core/storage";
import type { JobSpec, PublishingReport } from "@/shared/publishing";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";

let root: string; let store: PublishingStore; let job: JobSpec; let now: number;
const session = "original-session";
const sha256 = "c".repeat(64);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-cancellation-"));
  vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  store = new PublishingStore(path.join(root, "publisher")); now = Date.parse("2026-10-07T00:00:00Z");
  job = fixtureJob(); job.profile.privacy = "public"; job.profile.scheduled = true; job.originalPublishAt = "2026-10-09T12:00:00Z";
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-cancellation-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
});
/** 保存完整旧上传关联；缺失的改期修订仅存在于之后发来的取消指令中。 */
async function checkpoint(state: PublishingReport["state"], report: Partial<PublishingReport> = {}) {
  await store.write("entries.enc", seal([{ spec: job, session, sha256, finalChunkPossible: true, finalUpload: { asset: job.asset, relativePath: "Working/batch/version/output.mp4", sha256 }, finalized: false, resumeState: "finalizing", scheduleRevisionPending: true, reschedulePreviousAt: job.originalPublishAt, failures: 1, playlistsDone: [], report: { id: job.id, revision: 1, sequence: 1, state, videoId: "v1", offset: job.asset.size, total: job.asset.size, updatedAt: now, metadata: { title: "Persisted title", description: "Persisted description" }, effectivePublishAt: job.originalPublishAt, nextAttemptAt: now + 60_000, message: "Original blocked reason", ...report } }]));
}
/** 模拟设备离线时跳过第二版改期，重连只收到最新第三版取消意图。 */
function cancellation() { return { ...job, revision: 3, desired: "cancel" as const, originalPublishAt: "2026-10-10T12:00:00Z" }; }
/** 只等待合成后台执行安全落盘，不依据真实上传或固定长延时。 */
async function settle(runner: PublishingRunner) { for (let index = 0; index < 500 && runner.busy; index++) await new Promise(resolve => setTimeout(resolve, 5)); expect(runner.busy).toBe(false); }
/** 核对取消没有丢失文件、Hash 或会话，避免重启后被误判为新上传。 */
async function expectOriginalUpload() {
  const [entry] = unseal<{ session: string; sha256: string; finalChunkPossible: boolean; finalUpload: { asset: JobSpec["asset"]; relativePath: string; sha256: string } }[]>((await store.read<string>("entries.enc"))!);
  expect(entry).toMatchObject({ session, sha256, finalChunkPossible: true, finalUpload: { asset: job.asset, relativePath: "Working/batch/version/output.mp4", sha256 } });
}

it("cancels the original video after an undelivered timing revision and restart", async () => {
  await checkpoint("needs_attention"); const { api, videos } = fixtureApi();
  videos.set("v1", { id: "v1", status: { privacyStatus: "private", publishAt: job.originalPublishAt } });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(cancellation());
  expect((await runner.reports())[0]).toMatchObject({ revision: 3, state: "processing", videoId: "v1", effectivePublishAt: job.originalPublishAt });
  expect((await runner.reports())[0].nextAttemptAt).toBeUndefined(); await expectOriginalUpload(); await runner.stop();
  const restarted = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await restarted.tick(); await settle(restarted);
  expect((await restarted.reports())[0]).toMatchObject({ revision: 3, state: "cancelled", videoId: "v1" });
  expect(videos.get("v1")!.status!.publishAt).toBeUndefined(); expect(api.unschedule).toHaveBeenCalledExactlyOnceWith("v1");
  expect(api.begin).not.toHaveBeenCalled(); expect(api.chunk).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); await expectOriginalUpload(); await restarted.stop();
});

it.each([{ matches: [] as string[] }, { matches: ["v1"] }, { matches: ["v1", "v2"] }])("reconciles an unknown last chunk before cancellation after an undelivered revision (%j)", async ({ matches }) => {
  await checkpoint("needs_attention", { videoId: undefined, offset: 262144 }); const { api } = fixtureApi();
  api.probe.mockResolvedValue({ offset: 0, expired: true } as never); api.recover.mockResolvedValue(matches);
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(cancellation()); await runner.stop();
  const restarted = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await restarted.tick(); await settle(restarted);
  expect(api.probe).toHaveBeenCalledExactlyOnceWith(session, job.asset.size); expect(api.recover).toHaveBeenCalledExactlyOnceWith("LiveNest upload " + job.id, job.profile.channelId);
  expect(api.probe.mock.invocationCallOrder[0]).toBeLessThan(api.recover.mock.invocationCallOrder[0]);
  if (matches.length === 1) {
    expect((await restarted.reports())[0]).toMatchObject({ revision: 3, state: "cancelled", videoId: "v1" });
    expect(api.unschedule).toHaveBeenCalledExactlyOnceWith("v1"); expect(api.recover.mock.invocationCallOrder[0]).toBeLessThan(api.unschedule.mock.invocationCallOrder[0]);
  } else {
    expect((await restarted.reports())[0]).toMatchObject({ revision: 3, state: "needs_attention", message: expect.stringContaining("上传结果未知") });
    expect(api.unschedule).not.toHaveBeenCalled();
  }
  await expectOriginalUpload(); await restarted.stop();
  const again = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await again.tick(); await settle(again);
  expect((await again.reports())[0].state).toBe(matches.length === 1 ? "cancelled" : "needs_attention");
  expect(api.probe).toHaveBeenCalledOnce(); expect(api.begin).not.toHaveBeenCalled(); expect(api.chunk).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); await again.stop();
});

it("preserves known publication when cancellation includes an undelivered timing revision", async () => {
  await checkpoint("published", { observedPrivacy: "public" }); const { api } = fixtureApi();
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.apply(cancellation()); await runner.stop();
  const restarted = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await restarted.tick(); await settle(restarted);
  expect((await restarted.reports())[0]).toMatchObject({ revision: 3, state: "published", videoId: "v1", observedPrivacy: "public", effectivePublishAt: job.originalPublishAt, message: "视频已公开，取消未应用。" });
  expect(api.unschedule).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled(); expect(api.probe).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); await expectOriginalUpload(); await restarted.stop();
});
