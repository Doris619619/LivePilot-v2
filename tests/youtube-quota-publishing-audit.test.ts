/** 配额审计：验证普通发布批量读取、完成态休眠和配额重试，不读取素材或请求 Google。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { seal } from "../src/core/storage";
import { PublishingStore } from "../src/core/publishing/storage";
import { PublishingRunner } from "../src/core/publishing/runner";
import { VideoApiError } from "../src/core/youtube/video-api";
import { fixtureJob, fixtureApi } from "./publishing-fixtures";
class MemoryStore extends PublishingStore {
  files = new Map<string, unknown>();
  /** 仅从测试内存读取检查点。 */
  override async read<T>(name: string): Promise<T | null> { return this.files.has(name) ? structuredClone(this.files.get(name)) as T : null; }
  /** 保存独立副本，业务加密仍由真实实现完成。 */
  override async write(name: string, value: unknown) { this.files.set(name, structuredClone(value)); }
}
/** 发布审计使用固定加密配置；底层 fetch 一律禁止外部请求。 */
beforeEach(() => { vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network forbidden"); })); });
/** 清理仅作用于测试环境变量和函数替身。 */
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
/** 构造实际持久化格式的发布检查点；同频道与多频道使用真实分组逻辑。 */
async function fixture(count: number, distinct = false, state: "processing" | "published" = "processing") {
  const store = new MemoryStore("synthetic"); let now = Date.parse("2026-10-19T12:00:00Z");
  const entries = Array.from({ length: count }, (_, i) => {
    const spec = fixtureJob(); if (distinct) spec.profile.channelId = "channel_" + i;
    return { spec, report: { id: spec.id, revision: 1, sequence: 1, state, videoId: "v_" + i, offset: spec.asset.size, total: spec.asset.size, updatedAt: now }, playlistsDone: [], failures: 0 };
  });
  await store.write("entries.enc", seal(entries)); const { api, videos } = fixtureApi();
  for (const [i, entry] of entries.entries()) videos.set("v_" + i, { id: "v_" + i, snippet: { channelId: entry.spec.profile.channelId }, status: { privacyStatus: state === "published" ? "public" : "private" }, processingDetails: { processingStatus: state === "published" ? "succeeded" : "processing" } });
  const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api });
  return { runner, api, setNow: (value: number) => { now = value; }, start: now };
}
it("100 same-channel processing videos use two 50-ID reads in each due minute", async () => {
  const f = await fixture(100); await f.runner.tick();
  f.setNow(f.start + 59_000); await f.runner.tick(); expect(f.api.list).toHaveBeenCalledTimes(2);
  f.setNow(f.start + 60_000); await f.runner.tick();
  expect(f.api.list).toHaveBeenCalledTimes(4); expect(f.api.list.mock.calls.every(([ids]) => ids.length === 50)).toBe(true); await f.runner.stop();
});
it("100 distinct-channel videos cannot share a single authorization batch", async () => {
  const f = await fixture(100, true); await f.runner.tick(); expect(f.api.list).toHaveBeenCalledTimes(100); await f.runner.stop();
});
it("confirmed published videos do not keep polling every minute", async () => {
  const f = await fixture(2, false, "published"); await f.runner.tick(); for (let minute = 1; minute < 1440; minute++) { f.setNow(f.start + minute * 60_000); await f.runner.tick(); }
  expect(f.api.list).toHaveBeenCalledTimes(1); await f.runner.stop();
});
it("quota failure schedules retry but does not persist a project-wide midnight breaker", async () => {
  const f = await fixture(1); f.api.list.mockRejectedValue(new VideoApiError("VIDEO_QUOTA", "synthetic", true));
  await f.runner.tick(); const report = (await f.runner.reports())[0];
  expect(report).toMatchObject({ state: "retry_wait", nextAttemptAt: f.start + 30_000 });
  f.setNow(f.start + 29_000); await f.runner.tick(); expect(f.api.list).toHaveBeenCalledTimes(1); await f.runner.stop();
});
