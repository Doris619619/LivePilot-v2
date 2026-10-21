/** 管理员数据台恢复回归：真实政策事务、会话路由、明细轮转与导出；禁止外部请求。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, heartbeatAgent } from "@/cloud/agents";
import { admitYouTube, updateYouTubePolicy, youtubeUsageSummary } from "@/cloud/youtube-usage";
import { ingestYouTubeUsage, youtubeEvents } from "@/cloud/youtube-usage-events";
import { readYouTubeUsage, youtubeUsageStore } from "@/cloud/youtube-usage-store";
import { quotaDay } from "@/core/publishing/schedule";
import { accessStore, digest } from "@/server/access";
import { GET as exportEvents } from "@/app/api/admin/youtube-usage/export/route";
import { PUT as putPolicy } from "@/app/api/admin/youtube-usage/policy/route";
import { defaultYouTubePolicy, type YouTubePolicyUpdate, type YouTubeUsageEvent } from "@/shared/youtube-usage";
let dir: string;
const token = "d".repeat(64), origin = "http://127.0.0.1:3000";
/** 固定在PT午间但只模拟Date，锁重试和文件I/O保持真实。 */
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-21T19:00:00Z"));
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-usage-admin-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", dir); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client"); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External network forbidden"); }));
  const pairing = await createPairing("studio_a", "Synthetic"); await pairAgent("studio_a", pairing.code, "b".repeat(64)); const session = await openSession("studio_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("studio_a", session.session, []);
  await accessStore().write("access.json", { users: ["Uadmin", "Uother"].map(username => ({ username, role: "admin", revision: "r1", disabled: false })), sessions: { [digest(token)]: { username: "Uadmin", revision: "r1", expires: Date.now() + 90 * 86400_000 }, [digest("e".repeat(64))]: { username: "Uother", revision: "r1", expires: Date.now() + 90 * 86400_000 } }, attempts: {} });
});
/** 清理只覆盖本例独立目录，不接触真实账本。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-usage-admin-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 通过真实管理员同源会话构造读取或政策保存请求。 */
function request(url: string, body?: unknown, credential = token) { return new Request(origin + "/api/admin/youtube-usage/" + url, { method: body ? "PUT" : "GET", headers: { host: "127.0.0.1:3000", origin, cookie: "livepilot_session=" + credential, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
/** 只构造协议白名单事件，真实start必须先从Cloud准入。 */
function event(patch: Partial<YouTubeUsageEvent> = {}): YouTubeUsageEvent { return { eventId: randomUUID(), bootId: randomUUID(), sequence: 1, at: Date.now(), instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard", transport: "rest", kind: "decision", decision: "cache", ...patch }; }
it("M12 rejects a stale policy from the same administrator without rolling back another tab", async () => {
  const revision = (await youtubeUsageSummary() as unknown as { policyRevision: number }).policyRevision;
  const first = await putPolicy(request("policy", { policy: { ...defaultYouTubePolicy, dailyUnits: 6000 }, policyRevision: revision })); expect(first.status).toBe(200);
  const stale = await putPolicy(request("policy", { policy: { ...defaultYouTubePolicy, backgroundUnits: 1000 }, policyRevision: revision })); expect(stale.status).toBe(409);
  expect((await readYouTubeUsage()).policy).toMatchObject({ dailyUnits: 6000, backgroundUnits: 2000 });
  const current = await first.json(); const next = await putPolicy(request("policy", { policy: { ...current.policy, backgroundUnits: 1000 }, policyRevision: current.policyRevision })); expect(next.status).toBe(200);
  expect((await readYouTubeUsage()).policy).toMatchObject({ dailyUnits: 6000, backgroundUnits: 1000 });
});
it("M12 explicitly refuses old policy clients and keeps baseline-only updates compatible", async () => {
  const old = await putPolicy(request("policy", { policy: defaultYouTubePolicy })); expect(old.status).toBe(409); expect((await old.json()).error).toMatch(/刷新|版本/);
  await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 0, uploads: 0, source: "conservative-estimate" } }, "Uadmin"); expect((await youtubeUsageSummary()).baseline.known).toBe(true);
});
it("M12 gives legacy persisted ledgers revision zero and serializes competing administrators", async () => {
  await youtubeUsageSummary(); const store = youtubeUsageStore(); const saved = await store.read<Record<string, unknown>>("budget.json"); delete saved!.policyRevision; await store.write("budget.json", saved);
  const revision = (await youtubeUsageSummary() as unknown as { policyRevision: number }).policyRevision; expect(revision).toBe(0);
  const changes = await Promise.all([6000, 7000].map((dailyUnits, index) => putPolicy(request("policy", { policy: { ...defaultYouTubePolicy, dailyUnits }, policyRevision: revision } as YouTubePolicyUpdate, index ? "e".repeat(64) : token))));
  expect(changes.map(result => result.status).sort()).toEqual([200, 409]);
});
it("L01 marks aged day, partial ranges and unbounded queries expired while retaining the90-day aggregate", async () => {
  await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 0, uploads: 0, source: "conservative-estimate" } }, "Uadmin");
  const attemptId = randomUUID(); await admitYouTube("studio_a", { attemptId, clientFingerprint: createHash("sha256").update("synthetic-client").digest("hex"), instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard" });
  const oldAt = Date.now(), day = quotaDay(); await ingestYouTubeUsage("studio_a", [event({ kind: "start", decision: undefined, attemptId })]);
  vi.setSystemTime(oldAt + 15 * 86400_000); await ingestYouTubeUsage("studio_a", [event()]);
  const cutoff = Date.now() - 14 * 86400_000;
  for (const query of [{ day }, {}, { from: cutoff - 1, to: cutoff + 1000 }]) expect(await youtubeEvents(query)).toMatchObject({ incomplete: true, expired: true, detailsAvailableFrom: cutoff, droppedEvents: 0 });
  expect(await youtubeEvents({ from: cutoff, to: Date.now() })).toMatchObject({ incomplete: false, expired: false });
  expect(await youtubeEvents({ day: quotaDay() })).toMatchObject({ incomplete: false, expired: false });
  expect((await youtubeUsageSummary(day)).totals.attempts).toBe(1);
  for (const format of ["csv", "ndjson"]) { const response = await exportEvents(request("export?day=" + day + "&format=" + format)); expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain('"expired":true'); expect(text).toContain('"detailsAvailableFrom":' + cutoff); expect(text).toContain('"incomplete":true'); }
});
it("L01 uses PT calendar day boundaries across DST instead of assuming24-hour days", async () => {
  vi.setSystemTime(new Date("2026-11-15T07:30:00Z"));
  expect(await youtubeEvents({ day: "2026-11-01" })).toMatchObject({ expired: true });
  expect(await youtubeEvents({ day: "2026-11-02" })).toMatchObject({ expired: false });
});
it("L02 exports merged counts and explicit gaps consistently in CSV andJSONL", async () => {
  await ingestYouTubeUsage("studio_a", [event({ count: 120 }), event({ decision: "dropped", droppedEvents: 3 })]);
  expect((await youtubeUsageSummary()).totals.cacheHits).toBe(120);
  const csv = await (await exportEvents(request("export?day=" + quotaDay() + "&format=csv"))).text(); const rows = csv.split("\r\n").filter(line => line && !line.startsWith("#")); const columns = rows[0].split(","); expect(columns).toContain("count"); expect(columns).toContain("droppedEvents");
  const countAt = columns.indexOf("count"), droppedAt = columns.indexOf("droppedEvents"); expect(rows.slice(1).map(row => row.split(",")[countAt])).toContain('"120"'); expect(rows.slice(1).map(row => row.split(",")[droppedAt])).toContain('"3"');
  const json = await (await exportEvents(request("export?day=" + quotaDay() + "&format=ndjson"))).text(); expect(json).toContain('"count":120'); expect(json).toContain('"droppedEvents":3');
});
