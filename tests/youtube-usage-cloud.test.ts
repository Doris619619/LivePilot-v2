/** 全项目配额并发、持久幂等、PT日切及安全日志测试；禁止真实Google请求。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore } from "@/cloud/agents";
import { admitYouTube, reportYouTubeResult, updateYouTubePolicy, youtubeUsageSummary, reserveYouTubePublishing, releaseYouTubePublishing, seedLegacyYouTubePublishing } from "@/cloud/youtube-usage";
import { editYouTubeUsage, youtubeDay, youtubeUsageStore, YOUTUBE_HOT_LIMIT } from "@/cloud/youtube-usage-store";
import { ingestYouTubeUsage, youtubeEvents } from "@/cloud/youtube-usage-events";
import { quotaDay } from "@/core/publishing/schedule";
import { defaultYouTubePolicy, youtubeUsageEventSchema, youtubePolicySchema, type YouTubeAdmit, type YouTubeUsageEvent } from "@/shared/youtube-usage";
let dir: string;
const fingerprint = createHash("sha256").update("synthetic-oauth-client").digest("hex");
/** 两台真实注册的模拟设备共用一个合成OAuth项目，所有fetch被禁止。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-youtube-usage-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", dir); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-oauth-client"); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network permitted"); }));
  for (const id of ["studio_a", "studio_b"]) { const pairing = await createPairing(id, id); await pairAgent(id, pairing.code, (id === "studio_a" ? "b" : "c").repeat(64)); const session = await openSession(id, randomUUID(), [{ id: "main", name: "main" }]); await heartbeatAgent(id, session.session, []); }
});
/** 只清理已核验前缀的临时目录，并恢复测试时钟和环境。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-youtube-usage-")) throw new Error("Unsafe test cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 新attempt默认是一次后台频道查询。 */
function request(patch: Partial<YouTubeAdmit> = {}): YouTubeAdmit { return { attemptId: randomUUID(), instanceId: "main", clientFingerprint: fingerprint, method: "channels.list", purpose: "background", trigger: "dashboard", ...patch }; }
/** 通过管理员基线接口开启测试日，不直接伪造预算文件。 */
async function baseline(units = 0) { await updateYouTubePolicy({ baseline: { day: quotaDay(), units, uploads: 0, source: "conservative-estimate" } }, "Utest"); }
/** 构造只含白名单元数据的真实调用事件。 */
function event(patch: Partial<YouTubeUsageEvent> = {}): YouTubeUsageEvent { return { eventId: randomUUID(), bootId: randomUUID(), sequence: 1, at: Date.now(), instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard", transport: "rest", kind: "start", ...patch }; }
it("fails closed on first-day unknown history and on an unmapped OAuth client", async () => {
  expect(await admitYouTube("studio_a", request())).toMatchObject({ allowed: false, code: "YOUTUBE_BASELINE_UNKNOWN" });
  await baseline(); expect(await admitYouTube("studio_a", request({ clientFingerprint: "f".repeat(64) }))).toMatchObject({ allowed: false, code: "YOUTUBE_PROJECT_UNKNOWN" });
  expect((await youtubeUsageSummary()).usedUnits).toBe(0);
});
it("atomically permits exactly the last20 routine units across100 concurrent device attempts", async () => {
  // 固定在 PT 日中但保留流逝时间，避免并发场景跨日重置，同时不冻结事务的五秒期限。
  const nativeNow = Date.now.bind(Date); const offset = Date.parse("2026-10-21T20:00:00Z") - nativeNow();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => nativeNow() + offset);
  try {
    await baseline(8480);
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => admitYouTube(index % 2 ? "studio_a" : "studio_b", request())));
    expect(results.filter(r => r.allowed)).toHaveLength(20); expect((await youtubeUsageSummary()).usedUnits).toBe(20); expect((await youtubeUsageSummary()).remainingUnits).toBe(500);
  } finally { clock.mockRestore(); }
}, 20000);
it("durably deduplicates a lost admission response and rejects changed ownership", async () => {
  await baseline(); const input = request(); const first = await admitYouTube("studio_a", input);
  expect(await admitYouTube("studio_a", input)).toEqual(first); expect((await youtubeUsageSummary()).usedUnits).toBe(1);
  await expect(admitYouTube("studio_b", input)).rejects.toMatchObject({ code: "REQUEST" });
  expect(JSON.parse(await readFile(path.join(youtubeUsageStore().dir, "budget.json"), "utf8")).days[quotaDay()].units).toBe(1);
});
it("enforces send subbudget and the cost-based minute bucket without refunding unknown results", async () => {
  await baseline(); await updateYouTubePolicy({ policy: { ...defaultYouTubePolicy, sendUnits: 40 } }, "Utest");
  const inputs = [request({ method: "liveChatMessages.insert", purpose: "chat-send", trigger: "chat-send" }), request({ method: "liveChatMessages.insert", purpose: "chat-send", trigger: "chat-send" })];
  for (const input of inputs) { expect((await admitYouTube("studio_a", input)).allowed).toBe(true); await reportYouTubeResult("studio_a", { attemptId: input.attemptId, outcome: "unknown", durationMs: 1, errorCode: "network" }); }
  expect(await admitYouTube("studio_a", request({ method: "liveChatMessages.insert", purpose: "chat-send" }))).toMatchObject({ allowed: false, code: "YOUTUBE_PURPOSE_BUDGET" });
  const results = await Promise.all(Array.from({ length: 30 }, () => admitYouTube("studio_b", request()))); expect(results.filter(r => r.allowed)).toHaveLength(20);
  expect((await youtubeUsageSummary()).usedUnits).toBe(60);
});
it("propagates true daily quota across devices and preserves the breaker until PT midnight", async () => {
  vi.setSystemTime(new Date("2026-11-01T08:59:00Z")); await baseline(); const input = request(); const admission = await admitYouTube("studio_a", input);
  await reportYouTubeResult("studio_a", { attemptId: input.attemptId, outcome: "failed", durationMs: 1, httpStatus: 403, errorCode: "quotaExceeded" });
  expect(await admitYouTube("studio_b", request())).toMatchObject({ allowed: false, code: "YOUTUBE_DAILY_QUOTA" });
  vi.setSystemTime(admission.resetAt + 1); expect((await admitYouTube("studio_b", request())).allowed).toBe(true); expect((await youtubeUsageSummary()).baseline.source).toBe("observed-reset");
});
it("does not convert rate or network errors into a project daily breaker", async () => {
  await baseline(); const input = request(); await admitYouTube("studio_a", input); await reportYouTubeResult("studio_a", { attemptId: input.attemptId, outcome: "failed", durationMs: 1, grpcStatus: 8, errorCode: "rateLimitExceeded" });
  expect((await admitYouTube("studio_b", request())).allowed).toBe(true);
  await expect(reportYouTubeResult("studio_b", { attemptId: input.attemptId, outcome: "failed", durationMs: 1, errorCode: "quotaExceeded" })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("rejects invented control priority and counts global publication reservations", async () => {
  await baseline(8400); await expect(admitYouTube("studio_a", request({ purpose: "control", operationId: randomUUID() }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  const jobId = randomUUID(); expect(await reserveYouTubePublishing(jobId, 100, 1)).toBe(true); expect(await reserveYouTubePublishing(randomUUID(), 1, 0)).toBe(false);
  expect(await admitYouTube("studio_a", request())).toMatchObject({ allowed: false, code: "YOUTUBE_BUDGET" }); await releaseYouTubePublishing([jobId]); expect((await admitYouTube("studio_a", request())).allowed).toBe(true);
});
it("deduplicates batched events, preserves precise decision counts, and filters exports", async () => {
  await baseline(); const input = request(); await admitYouTube("studio_a", input);
  const start = event({ attemptId: input.attemptId }); const finish = event({ attemptId: input.attemptId, kind: "finish", outcome: "failed", errorCode: "network" }); const cache = event({ kind: "decision", decision: "cache", count: 120 });
  await ingestYouTubeUsage("studio_a", [start, finish, cache]); await ingestYouTubeUsage("studio_a", [start, finish, cache]);
  const summary = await youtubeUsageSummary(); expect(summary.totals).toEqual({ attempts: 1, failures: 1, cacheHits: 120, blocked: 0 }); expect(summary.byMethod["channels.list"]).toBe(1); expect(summary.instanceRanking).toEqual([{ agentId: "studio_a", instanceId: "main", attempts: 1, units: 1 }]);
  expect((await youtubeEvents({ agentId: "studio_a", outcome: "failed" })).events).toHaveLength(1); expect((await youtubeEvents({ agentId: "studio_b" }, true)).events).toHaveLength(0);
  expect((await youtubeEvents({ from: Date.now() + 1 }, true)).events).toHaveLength(0);
});
it("rejects secret fields, reports upload transport cost as unverified, and counts capability coverage", async () => {
  expect(youtubeUsageEventSchema.safeParse({ ...event(), token: "secret" }).success).toBe(false); expect(youtubePolicySchema.safeParse({ ...defaultYouTubePolicy, dailyUnits: 10000 }).success).toBe(false);
  const input = request({ method: "videos.upload.chunk" }); await admitYouTube("studio_a", input);
  await agentStore("studio_a").write("capabilities.json", ["youtube-quota-v1", "youtube-usage-v1"]); await ingestYouTubeUsage("studio_a", [event({ attemptId: input.attemptId, method: "videos.upload.chunk", transport: "upload" })]);
  expect((await youtubeEvents({})).events[0].estimatedUnits).toBeNull(); expect((await youtubeUsageSummary()).coverage).toMatchObject({ total: 2, protected: 1 });
  await agentStore("studio_a").write("capabilities.json", ["youtube-quota-v1"]); expect((await youtubeUsageSummary()).coverage.protected).toBe(0);
});
it("retains daily aggregates when aged detail rotates and never silently resets corrupt budget files", async () => {
  await baseline(); const input = request(); await admitYouTube("studio_a", input); await ingestYouTubeUsage("studio_a", [event({ attemptId: input.attemptId })]); vi.setSystemTime(Date.now() + 15 * 86400_000); const next = request(); await admitYouTube("studio_a", next); await ingestYouTubeUsage("studio_a", [event({ attemptId: next.attemptId })]); expect((await youtubeEvents({})).events).toHaveLength(1);
  await editYouTubeUsage(state => { youtubeDay(state); }); expect((await youtubeUsageSummary()).baseline.known).toBe(true);
  await writeFile(path.join(youtubeUsageStore().dir, "budget.json"), "corrupt-json"); await expect(admitYouTube("studio_a", request())).rejects.toMatchObject({ code: "STORAGE" });
});
it("imports old publishing consumption once, adjusts the external baseline and releases cancelled reservations", async () => {
  const job = randomUUID(); await seedLegacyYouTubePublishing({ day: quotaDay(), units: 200, uploads: 2, reservations: { [job]: { units: 50, uploads: 1 } } });
  expect((await youtubeUsageSummary()).baseline.known).toBe(false); await baseline(500);
  const imported = await youtubeUsageSummary(); expect(imported.usedUnits).toBe(200); expect(imported.baseline.units).toBe(300); expect(imported.reservedUnits).toBe(50);
  await seedLegacyYouTubePublishing({ day: quotaDay(), units: 200, uploads: 2, reservations: {} }); expect((await youtubeUsageSummary()).usedUnits).toBe(200); await releaseYouTubePublishing([job]); expect((await youtubeUsageSummary()).reservedUnits).toBe(0);
  await seedLegacyYouTubePublishing({ day: quotaDay(), units: 200, uploads: 2, reservations: { [job]: { units: 50, uploads: 1 } } }); expect((await youtubeUsageSummary()).reservedUnits).toBe(0);
});
it.each(["wrong-number", -1])("rejects validJSON corrupted budget units %s without allowing any API", async bad => {
  await baseline(); const file = path.join(youtubeUsageStore().dir, "budget.json"); const value = JSON.parse(await readFile(file, "utf8")); value.days[quotaDay()].units = bad; await writeFile(file, JSON.stringify(value));
  await expect(admitYouTube("studio_a", request())).rejects.toMatchObject({ code: "STORAGE" });
});
it("uses an independent search bucket and retains the general reserve", async () => {
  await baseline(); await updateYouTubePolicy({ policy: { ...defaultYouTubePolicy, searchesPerDay: 1 } }, "Utest");
  expect(await admitYouTube("studio_a", request({ method: "search.list", purpose: "interactive" }))).toMatchObject({ allowed: true, units: 1, bucket: "search" });
  expect(await admitYouTube("studio_b", request({ method: "search.list", purpose: "interactive" }))).toMatchObject({ allowed: false, code: "YOUTUBE_BUDGET" });
  expect((await youtubeUsageSummary()).usedUnits).toBe(0); expect((await youtubeUsageSummary()).searches).toBe(1);
});
it("applies a delayed genuine quota finish but never trusts an unadmitted attempt or another device", async () => {
  await baseline(); const input = request(); await admitYouTube("studio_a", input);
  await ingestYouTubeUsage("studio_b", [event({ attemptId: input.attemptId, kind: "finish", outcome: "failed", errorCode: "quotaExceeded" })]);
  expect((await admitYouTube("studio_b", request())).allowed).toBe(true);
  await ingestYouTubeUsage("studio_a", [event({ attemptId: input.attemptId, kind: "finish", outcome: "failed", errorCode: "quotaExceeded", httpStatus: 403 })]);
  expect(await admitYouTube("studio_b", request())).toMatchObject({ allowed: false, code: "YOUTUBE_DAILY_QUOTA" });
  await ingestYouTubeUsage("studio_a", [event({ attemptId: randomUUID() })]); const summary = await youtubeUsageSummary(); expect(summary.incomplete).toBe(true); expect(summary.totals.attempts).toBe(0);
});
it("enforces the existing publication unit and upload sublimits on the new unified path", async () => {
  await baseline(); const { publishingStore } = await import("@/cloud/publishing"); await publishingStore().write("state.json", { policy: { otherUnitsPerDay: 1, uploadsPerDay: 1 } });
  expect((await admitYouTube("studio_a", request({ purpose: "publishing", method: "videos.list" }))).allowed).toBe(true);
  expect(await admitYouTube("studio_a", request({ purpose: "publishing", method: "videos.list" }))).toMatchObject({ allowed: false, code: "YOUTUBE_PUBLISHING_BUDGET" });
  expect((await admitYouTube("studio_a", request({ purpose: "publishing", method: "videos.insert" }))).allowed).toBe(true);
  expect(await admitYouTube("studio_a", request({ purpose: "publishing", method: "videos.insert" }))).toMatchObject({ allowed: false, code: "YOUTUBE_PUBLISHING_BUDGET" });
});
it("archives old receipts once, rejects prior-day reuse and accepts delayed stream results from the daily archive", async () => {
  vi.setSystemTime(new Date("2026-10-20T19:00:00Z")); await baseline(); const input = request({ method: "liveChatMessages.streamList", purpose: "chat-stream", trigger: "chat-connect" }); await admitYouTube("studio_a", input); const firstDay = quotaDay();
  vi.setSystemTime(Date.now() + 86400_000); const next = request(); await admitYouTube("studio_a", next);
  let hot = JSON.parse(await readFile(path.join(youtubeUsageStore().dir, "budget.json"), "utf8")); expect(hot.days[firstDay].receipts).toEqual({}); const archivedFile = path.join(youtubeUsageStore().dir, "receipts-" + firstDay + ".json");
  expect(JSON.parse(await readFile(archivedFile, "utf8")).receipts[input.attemptId]).toBeTruthy();
  expect(await admitYouTube("studio_a", input)).toMatchObject({ allowed: false, code: "YOUTUBE_ATTEMPT_EXPIRED" }); expect((await youtubeUsageSummary()).usedUnits).toBe(1);
  await ingestYouTubeUsage("studio_a", [event({ attemptId: input.attemptId, method: input.method, purpose: "chat-stream", trigger: "chat-connect", transport: "grpc", kind: "finish", outcome: "failed", errorCode: "quotaExceeded", grpcStatus: 8 })]);
  expect(await admitYouTube("studio_b", request())).toMatchObject({ allowed: false, code: "YOUTUBE_DAILY_QUOTA" });
  expect(JSON.parse(await readFile(archivedFile, "utf8")).receipts[input.attemptId].result.errorCode).toBe("quotaExceeded");
  await reportYouTubeResult("studio_a", { attemptId: input.attemptId, outcome: "failed", durationMs: 1, errorCode: "quotaExceeded" });
  hot = JSON.parse(await readFile(path.join(youtubeUsageStore().dir, "budget.json"), "utf8")); expect(hot.days[firstDay].receipts).toEqual({}); expect(hot.days[firstDay].units).toBe(5);
});
it("refuses new normal and zero-unit admissions at the32MiB hot-ledger capacity without deleting idempotency", async () => {
  await baseline(); const input = request({ method: "oauth.token", purpose: "authorization" }); const admission = await admitYouTube("studio_a", input);
  await editYouTubeUsage(state => { const day = youtubeDay(state); const base = day.receipts[input.attemptId]; for (let index = 0; index < 35000; index++) { const id = randomUUID(); day.receipts[id] = { ...base, input: { ...base.input, attemptId: id }, admission: { ...base.admission, attemptId: id } }; } });
  expect(await admitYouTube("studio_a", request({ method: "oauth.token", purpose: "authorization" }))).toMatchObject({ allowed: false, code: "YOUTUBE_PROTECTION_STORAGE" });
  expect(await admitYouTube("studio_a", request())).toMatchObject({ allowed: false, code: "YOUTUBE_PROTECTION_STORAGE" });
  expect(await admitYouTube("studio_a", input)).toEqual(admission); const summary = await youtubeUsageSummary(); expect(summary.storage?.blocked).toBe(true); expect(summary.storage?.limit).toBe(YOUTUBE_HOT_LIMIT);
}, 30000);
