/** Agent 配额保护与日志回归：真实临时文件、模拟 Cloud、禁止真实 Google 网络。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/storage";
import { AgentYouTubeUsage } from "../src/agent/youtube-usage";
import { AppError } from "../src/core/errors";
import { youtubeCost, type YouTubeAdmission, type YouTubeUsageEvent } from "../src/shared/youtube-usage";
import type { YouTubeAttempt, YouTubeRuntimeEvent } from "../src/core/youtube/usage";
import type { Transport } from "../src/agent/transport";
const root = path.resolve(".data/tests");
const directories: string[] = []; const runtimes: AgentYouTubeUsage[] = [];
/** 所有测试只访问隔离临时目录，意外 fetch 立即失败。 */
beforeEach(() => { vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client"); vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real network forbidden"); })); });
/** 先落盘退出，再验证目录边界并清理自己的测试目录。 */
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); for (const dir of directories.splice(0)) { if (!dir.startsWith(root + path.sep)) throw Error("Unexpected cleanup path"); await rm(dir, { recursive: true, force: true }); } vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
/** 构造一笔真实方法的合成请求，不包含频道、凭据或消息正文。 */
function attempt(): YouTubeAttempt { return { attemptId: randomUUID(), instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard" }; }
/** 模拟 Cloud 准入回复，保持精确 attemptId 便于响应丢失测试。 */
function permit(input: YouTubeAttempt): YouTubeAdmission { const cost = youtubeCost(input.method); return { allowed: true, attemptId: input.attemptId, project: "current-project", quotaDay: "2026-10-20", units: cost.units, bucket: cost.bucket, remaining: 8999, backgroundRemaining: 1999, activeInstances: 1, resetAt: Date.now() + 86400_000 }; }
/** 建立可控时钟、真实本地日志和完全内存 Cloud。 */
async function fixture(maxBytes?: number) {
  const dir = path.join(root, "quota-agent-" + randomUUID()); await mkdir(dir, { recursive: true }); directories.push(dir);
  let now = Date.now();
  const post = vi.fn(async (route: string, body: Record<string, unknown>) => {
    if (route.endsWith("/admit")) return permit(body as YouTubeAttempt);
    if (route.endsWith("/youtube-usage")) return { acknowledged: (body.events as YouTubeUsageEvent[]).map(event => event.eventId) };
    return { ok: true };
  });
  const transport = { session: "synthetic-session", post } as unknown as Transport;
  const store = new Store(dir); const runtime = new AgentYouTubeUsage(transport, { store, now: () => now, maxBytes }); runtimes.push(runtime);
  return { runtime, transport, post, store, dir, now: () => now, advance: (ms: number) => { now += ms; } };
}
/** 有效能力只用于配额入口，不能被当成 Google 调用已经成功的证明。 */
function connect(runtime: AgentYouTubeUsage) { runtime.connect(["youtube-quota-v1", "youtube-usage-v1"]); }
/** 记录合成出站事实，默认调用成功；数据体只使用白名单字段。 */
function event(now: number, kind: "start" | "finish" = "start"): YouTubeRuntimeEvent { return { ...attempt(), at: now, kind, transport: "rest", ...(kind === "finish" ? { outcome: "succeeded" as const, durationMs: 25 } : {}) }; }
it("fails closed before registration and against old Cloud without sending admission requests", async () => {
  const f = await fixture(); expect((await f.runtime.admit(attempt())).allowed).toBe(false);
  f.runtime.connect(["youtube-usage-v1"]); expect((await f.runtime.admit(attempt())).allowed).toBe(false); expect(f.post).not.toHaveBeenCalled();
  connect(f.runtime); expect((await f.runtime.admit(attempt())).allowed).toBe(true); expect(f.post).toHaveBeenCalledOnce();
});
it("retries a lost Cloud admission response with the same ID and no Google call", async () => {
  const f = await fixture(); connect(f.runtime);
  f.post.mockRejectedValueOnce(new AppError("CLOUD_NETWORK", "synthetic"));
  const input = attempt(); expect((await f.runtime.admit(input)).allowed).toBe(true);
  expect(f.post).toHaveBeenCalledTimes(2); expect(f.post.mock.calls[0][1]).toEqual(f.post.mock.calls[1][1]); expect(fetch).not.toHaveBeenCalled();
});
it("does not grant a late permit after the Cloud connection has been closed", async () => {
  const f = await fixture(); connect(f.runtime); let release: ((value: YouTubeAdmission) => void) | undefined;
  const started = new Promise<void>(resolve => { f.post.mockImplementationOnce(async () => { resolve(); return await new Promise<YouTubeAdmission>(value => { release = value; }); }); });
  const input = attempt(); const pending = f.runtime.admit(input); await started;
  f.runtime.disconnect(); release!(permit(input)); expect((await pending).allowed).toBe(false);
});
it("persists explicit provider quota blocks across Agent restart", async () => {
  const f = await fixture(); connect(f.runtime);
  await f.runtime.record({ ...event(f.now(), "finish"), outcome: "failed", httpStatus: 403, errorCode: "quotaExceeded" });
  f.post.mockClear(); expect((await f.runtime.admit(attempt())).allowed).toBe(false);
  const restarted = new AgentYouTubeUsage(f.transport, { store: f.store, now: f.now }); runtimes.push(restarted); connect(restarted);
  expect((await restarted.admit(attempt())).code).toBe("YOUTUBE_DAILY_QUOTA"); expect(f.post).not.toHaveBeenCalled();
});
it("aggregates 500 cache observations without dropping counts or writing 500 events", async () => {
  const f = await fixture(); connect(f.runtime); const base = { ...event(f.now()), kind: "decision" as const, decision: "cache" as const };
  for (let i = 0; i < 500; i++) await f.runtime.record(base);
  expect(await readdir(f.dir)).toEqual([]);
  f.advance(60_000); await f.runtime.flush();
  const sent = f.post.mock.calls.filter(([route]) => route.endsWith("/youtube-usage"))[0][1].events as YouTubeUsageEvent[];
  expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ kind: "decision", decision: "cache", count: 500 });
});
it("keeps distinct accounts and protection reasons separate in decision aggregates", async () => {
  const f = await fixture(); connect(f.runtime);
  const base = { ...event(f.now()), kind: "decision" as const, decision: "blocked" as const, blockReason: "YOUTUBE_BUDGET" as const, accountId: randomUUID() };
  await f.runtime.record(base); await f.runtime.record(base);
  await f.runtime.record({ ...base, accountId: randomUUID() });
  await f.runtime.record({ ...base, blockReason: "YOUTUBE_RATE" });
  f.advance(60_000); await f.runtime.flush();
  const sent = f.post.mock.calls.find(([route]) => route.endsWith("/youtube-usage"))![1].events as YouTubeUsageEvent[];
  expect(sent).toHaveLength(3); expect(sent.map(item => item.count).sort()).toEqual([1, 1, 2]);
});
it("preserves Cloud storage protection failures instead of reporting an unrelated disconnect", async () => {
  const f = await fixture(); connect(f.runtime); f.post.mockRejectedValueOnce(new AppError("YOUTUBE_PROTECTION_STORAGE", "synthetic"));
  expect(await f.runtime.admit(attempt())).toMatchObject({ allowed: false, code: "YOUTUBE_PROTECTION_STORAGE" });
  expect(f.post).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});
it("retains acknowledged details locally and sends each immutable event ID only until acknowledgment", async () => {
  const f = await fixture(); connect(f.runtime); await f.runtime.record(event(f.now())); await f.runtime.flush();
  const sent = f.post.mock.calls[0][1].events as YouTubeUsageEvent[];
  const archive = (await readdir(f.dir)).find(name => name.startsWith("archive-"))!;
  expect(JSON.parse(await readFile(path.join(f.dir, archive), "utf8")).events[0].eventId).toBe(sent[0].eventId);
  f.advance(6000); await f.runtime.flush(); expect(f.post).toHaveBeenCalledOnce();
});
it("keeps the same event IDs after a lost upload acknowledgment", async () => {
  const f = await fixture(); connect(f.runtime); await f.runtime.record(event(f.now()));
  f.post.mockRejectedValueOnce(new Error("synthetic network")); await f.runtime.flush();
  const first = f.post.mock.calls[0][1]; f.advance(6000); await f.runtime.flush();
  expect(f.post.mock.calls[1][1]).toEqual(first);
});
it("records persistent gaps when unacknowledged detail exceeds the disk budget", async () => {
  const f = await fixture(1); connect(f.runtime); await f.runtime.record(event(f.now())); await f.runtime.flush();
  const metadata = await f.store.read<{ droppedEvents: number; pendingDropped: number }>("metadata.json");
  expect(metadata?.droppedEvents).toBe(1); expect(metadata?.pendingDropped).toBe(1); expect(f.post).not.toHaveBeenCalled();
});
it("rotates expired unacknowledged details while fully offline without any Cloud request", async () => {
  const f = await fixture(); await f.runtime.record(event(f.now())); await f.runtime.maintain();
  f.advance(8 * 86400_000); await f.runtime.maintain();
  const metadata = await f.store.read<{ droppedEvents: number; pendingDropped: number }>("metadata.json");
  expect(metadata).toMatchObject({ droppedEvents: 1, pendingDropped: 1 }); expect(f.post).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("bounds offline disk growth and suppresses repeated maintenance writes within a minute", async () => {
  const f = await fixture(1); await f.runtime.record(event(f.now())); const write = vi.spyOn(f.store, "write");
  await f.runtime.maintain(); expect((await f.store.read<{ droppedEvents: number }>("metadata.json"))?.droppedEvents).toBe(1);
  const count = write.mock.calls.length; await f.runtime.maintain(); expect(write.mock.calls.length).toBe(count); expect(f.post).not.toHaveBeenCalled();
});
it("treats log write failures as visible gaps while valid Cloud admission remains independent", async () => {
  const f = await fixture(); connect(f.runtime); vi.spyOn(f.store, "write").mockRejectedValue(new Error("synthetic disk failure"));
  await f.runtime.record(event(f.now())); expect(f.runtime.status()).toMatchObject({ logFailed: true, droppedEvents: 1 });
  expect((await f.runtime.admit(attempt())).allowed).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
