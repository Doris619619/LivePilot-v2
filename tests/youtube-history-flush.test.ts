/** 历史事件的真实 Cloud 准入/事务与 Agent 分段补传集成回归；Google 仅使用合成响应。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentYouTubeUsage } from "@/agent/youtube-usage";
import type { Transport } from "@/agent/transport";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent } from "@/cloud/agents";
import { beginPublishingAccountCleanup, claimPublishingAccount, completePublishingAccountCleanup, createPublishingAccount } from "@/cloud/publishing-accounts";
import { ingestYouTubeUsage, youtubeEvents } from "@/cloud/youtube-usage-events";
import { admitYouTube, reportYouTubeResult, updateYouTubePolicy, youtubeUsageSummary } from "@/cloud/youtube-usage";
import { readYouTubeUsage, youtubeDay, youtubeUsageStore } from "@/cloud/youtube-usage-store";
import { quotaDay } from "@/core/publishing/schedule";
import { Store } from "@/core/storage";
import { PublishingStore } from "@/core/publishing/storage";
import { AppError } from "@/core/errors";
import { installYouTubeRuntime, youtubeFetch } from "@/core/youtube/usage";
import { defaultYouTubePolicy, type YouTubeAdmit, type YouTubeResult, type YouTubeUsageEvent } from "@/shared/youtube-usage";
let root: string, now: number;
const runtimes: AgentYouTubeUsage[] = [];
const client = "synthetic-history-client", actor = { username: "admin", role: "admin" as const };
const fingerprint = createHash("sha256").update(client).digest("hex");
/** 准入全部经过真实 Cloud 预算，默认历史基线由公开管理员接口确认。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-youtube-history-")); now = Date.parse("2026-10-21T12:00:00Z"); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("GOOGLE_CLIENT_ID", client);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url !== "https://google.synthetic.invalid/channels") throw new Error("Unexpected external network"); return Response.json({ items: [] }); }));
  for (const agentId of ["pc_a", "pc_b"]) { const pair = await createPairing(agentId, agentId); await pairAgent(agentId, pair.code, "b".repeat(64)); const session = await openSession(agentId, randomUUID(), [{ id: "main", name: "Main" }, { id: "second", name: "Second" }]); await heartbeatAgent(agentId, session.session, []); await agentStore(agentId).write("capabilities.json", ["youtube-quota-v1", "youtube-usage-v1", "publishing-accounts-v1"]); }
  await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 0, uploads: 0, source: "conservative-estimate" }, policy: { ...defaultYouTubePolicy, burstUnits: 1000, unitsPerMinute: 1000 }, policyRevision: (await youtubeUsageSummary()).policyRevision }, "synthetic-admin");
});
/** 停止运行时后，只清理本轮经过核验的独立临时目录。 */
afterEach(async () => { installYouTubeRuntime(undefined); for (const runtime of runtimes.splice(0)) await runtime.stop(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-youtube-history-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 为设备建立真实持久账号路由，Token 和 Google OAuth 始终未创建。 */
async function account(agentId = "pc_a", instanceId = "main") { const value = await createPublishingAccount(actor, agentId, instanceId, "Synthetic"); await claimPublishingAccount(agentId, value.id, instanceId, "channel_" + value.id.replaceAll("-", ""), "Synthetic", true, now); return value; }
/** Cloud 传输仅替换网络边界；准入、结果和事件全部调用真实生产函数。 */
function runtime(agentId = "pc_a") {
  const store = new Store(path.join(root, "agent-log-" + agentId)); const sent: YouTubeUsageEvent[][] = []; let loseAcknowledgment = false;
  const post = vi.fn(async (route: string, body: unknown) => {
    if (route.endsWith("/admit")) return admitYouTube(agentId, body as YouTubeAdmit);
    if (route.endsWith("/result")) return reportYouTubeResult(agentId, body as YouTubeResult);
    if (route.endsWith("/youtube-usage")) { const events = (body as { events: YouTubeUsageEvent[] }).events; sent.push(structuredClone(events)); const response = await ingestYouTubeUsage(agentId, events); if (loseAcknowledgment) { loseAcknowledgment = false; throw new AppError("CLOUD_NETWORK", "Synthetic lost acknowledgment"); } return response; }
    throw new Error("Unexpected Cloud route");
  });
  const value = new AgentYouTubeUsage({ session: "synthetic-session", post } as unknown as Transport, { store, now: () => now }); value.connect(["youtube-quota-v1", "youtube-usage-v1"]); runtimes.push(value);
  return { value, store, sent, loseNextAcknowledgment: () => { loseAcknowledgment = true; } };
}
/** 统一推进 Agent 和 Cloud 时钟，让补传退避及分钟聚合可以真实执行。 */
function advance(ms = 6000) { now += ms; vi.setSystemTime(now); }
/** 执行一次经过真实准入的合成 Google GET，并由真实运行时记录 start/finish。 */
async function call(value: AgentYouTubeUsage, accountId?: string, instanceId = "main") { installYouTubeRuntime(value); await youtubeFetch("channels.list", { instanceId, ...(accountId ? { accountId } : {}), purpose: "interactive", trigger: "metadata" }, () => fetch("https://google.synthetic.invalid/channels")); }
/** 读取仍未确认的 Agent 分段，已确认档案不会参与下一次补传。 */
async function pending(store: Store) { const rows = await readdir(store.dir).catch(() => []); const segments = await Promise.all(rows.filter(name => /^(segment-.*|current)\.json$/.test(name)).map(name => store.read<{ events: YouTubeUsageEvent[] }>(name))); return segments.flatMap(row => row?.events || []); }
/** 构造永久不可接收/决策事件，身份字段仅为白名单合成值。 */
function event(patch: Partial<YouTubeUsageEvent> = {}): YouTubeUsageEvent { return { eventId: randomUUID(), bootId: randomUUID(), sequence: 1, at: now, instanceId: "main", method: "channels.list", purpose: "interactive", trigger: "metadata", transport: "rest", kind: "start", ...patch }; }
it("drains more than 64 mixed pending/deleted-account history records before later healthy events", async () => {
  const pendingAccount = await account(), deletedAccount = await account(); const f = runtime();
  for (let index = 0; index < 32; index++) await call(f.value, index % 2 ? deletedAccount.id : pendingAccount.id);
  await beginPublishingAccountCleanup("pc_a", pendingAccount.id, "synthetic"); const cleanup = await beginPublishingAccountCleanup("pc_a", deletedAccount.id, "synthetic"); await completePublishingAccountCleanup("pc_a", cleanup.id);
  await call(f.value); expect(fetch).toHaveBeenCalledTimes(33);
  await f.value.flush(); advance(); await f.value.flush();
  expect(f.sent.map(batch => batch.length)).toEqual([64, 2]); expect(await pending(f.store)).toHaveLength(0);
  const summary = await youtubeUsageSummary(); expect(summary.totals.attempts).toBe(33); expect(summary.usedUnits).toBe(33); expect(summary.incomplete).toBe(false); expect((await youtubeEvents({})).events).toHaveLength(66);
  await expect(admitYouTube("pc_a", { attemptId: randomUUID(), clientFingerprint: fingerprint, instanceId: "main", accountId: deletedAccount.id, method: "channels.list", purpose: "interactive", trigger: "metadata" })).rejects.toBeDefined();
}, 20000);
it("accepts receipt-backed history after instance retirement but gaps unknown or foreign decisions without exposing their IDs", async () => {
  const historical = await account("pc_a", "second"), foreign = await account("pc_b"); const f = runtime(); await call(f.value, historical.id, "second");
  const cleanup = await beginPublishingAccountCleanup("pc_a", historical.id, "synthetic"); await completePublishingAccountCleanup("pc_a", cleanup.id);
  // This branch predates instance retirement; preserve the same future tombstone shape without importing PR47 behavior.
  const registry = await (await import("@/cloud/store")).cloudStore().read<{ agents: { id: string; instances: { id: string; name: string }[]; retiredInstanceIds?: string[] }[] }>("agents.json"); const a = registry!.agents.find(value => value.id === "pc_a")!; a.instances = a.instances.filter(value => value.id !== "second"); a.retiredInstanceIds = ["second"]; await (await import("@/cloud/store")).cloudStore().write("agents.json", registry);
  await f.value.record({ at: now, instanceId: "second", accountId: historical.id, method: "channels.list", purpose: "interactive", trigger: "metadata", transport: "rest", kind: "decision", decision: "cache", count: 3 });
  await f.value.record({ at: now, instanceId: "main", accountId: foreign.id, method: "channels.list", purpose: "interactive", trigger: "metadata", transport: "rest", kind: "decision", decision: "cache", count: 4 });
  await f.value.record({ at: now, instanceId: "unknown", method: "channels.list", purpose: "interactive", trigger: "metadata", transport: "rest", kind: "decision", decision: "blocked", count: 2 });
  advance(60000); await f.value.flush(); expect(await pending(f.store)).toHaveLength(0);
  const summary = await youtubeUsageSummary(); expect(summary.totals).toMatchObject({ attempts: 1, cacheHits: 3 }); expect(summary.droppedEvents).toBe(6);
  const rows = (await youtubeEvents({})).events; expect(JSON.stringify(rows)).not.toContain(foreign.id); expect(rows.filter(row => row.decision === "dropped").every(row => !row.accountId && !row.attemptId && !row.jobId && !row.operationId)).toBe(true);
});
it("acknowledges unreceipted and cross-device records as gaps but never mutates someone else's receipt", async () => {
  const input: YouTubeAdmit = { attemptId: randomUUID(), clientFingerprint: fingerprint, instanceId: "main", method: "channels.list", purpose: "interactive", trigger: "metadata" }; expect((await admitYouTube("pc_b", input)).allowed).toBe(true);
  const own: YouTubeAdmit = { ...input, attemptId: randomUUID() }; expect((await admitYouTube("pc_a", own)).allowed).toBe(true);
  const malformed = [event({ attemptId: input.attemptId, kind: "finish", outcome: "failed", errorCode: "quotaExceeded" }), event({ attemptId: randomUUID() }), event({ attemptId: own.attemptId, purpose: "control", kind: "finish", outcome: "failed", errorCode: "quotaExceeded" }), event({ at: now + 600000 })];
  expect((await ingestYouTubeUsage("pc_a", malformed)).acknowledged).toEqual(malformed.map(row => row.eventId));
  const state = await readYouTubeUsage(); expect(youtubeDay(state).receipts[input.attemptId].result).toBeUndefined(); expect(youtubeDay(state).receipts[own.attemptId].result).toBeUndefined(); expect((await youtubeUsageSummary()).breakerUntil || 0).toBe(0);
  expect((await youtubeUsageSummary()).droppedEvents).toBe(4); expect(JSON.stringify((await youtubeEvents({})).events)).not.toContain(input.attemptId);
});
it("acknowledges a full poisoned first batch as explicit gaps so a later admitted request can flush", async () => {
  const f = runtime();
  for (let index = 0; index < 64; index++) await f.value.record({ attemptId: randomUUID(), at: index === 0 ? now + 600000 : now, instanceId: "main", method: "channels.list", purpose: "interactive", trigger: "metadata", transport: "rest", kind: "start" });
  await call(f.value); await f.value.flush(); advance(); await f.value.flush();
  expect(f.sent.map(batch => batch.length)).toEqual([64, 2]); expect(await pending(f.store)).toHaveLength(0);
  const summary = await youtubeUsageSummary(); expect(summary.droppedEvents).toBe(64); expect(summary.totals.attempts).toBe(1); expect(summary.usedUnits).toBe(1);
});
it("retries identical event IDs after a lost acknowledgment without recounting or refunding admission", async () => {
  const f = runtime(); await call(f.value); f.loseNextAcknowledgment(); await f.value.flush(); expect(await pending(f.store)).toHaveLength(2); advance(); await f.value.flush();
  expect(f.sent).toHaveLength(2); expect(f.sent[1]).toEqual(f.sent[0]); expect(await pending(f.store)).toHaveLength(0); expect((await youtubeUsageSummary()).totals.attempts).toBe(1); expect((await youtubeUsageSummary()).usedUnits).toBe(1);
});
it("does not acknowledge transient event-index storage failures and eventually persists the original finish result", async () => {
  const f = runtime(); await call(f.value); const write = PublishingStore.prototype.write; let fail = true;
  vi.spyOn(PublishingStore.prototype, "write").mockImplementation(async function (this: PublishingStore, name, value) { if (fail && this.dir === youtubeUsageStore().dir && name === "events-index.json") { fail = false; throw new Error("Synthetic disk failure"); } return write.call(this, name, value); });
  await f.value.flush(); expect(await pending(f.store)).toHaveLength(2); expect(f.value.status().logFailed).toBe(true); advance(); await f.value.flush();
  expect(f.sent[1]).toEqual(f.sent[0]); expect(await pending(f.store)).toHaveLength(0); expect((await youtubeUsageSummary()).totals.attempts).toBe(1);
  const state = await readYouTubeUsage(); const receipt = Object.values(youtubeDay(state).receipts)[0]; expect(receipt.result).toMatchObject({ outcome: "succeeded", httpStatus: 200 });
});
it("still rejects raw secrets instead of accepting an expanded telemetry envelope", async () => {
  await expect(ingestYouTubeUsage("pc_a", [{ ...event(), token: "synthetic-secret" } as unknown as YouTubeUsageEvent])).rejects.toBeDefined();
});
it("does not let a valid duplicate event ID authorize an unrelated start record", async () => {
  const id = randomUUID(); const rows = [event({ eventId: id }), event({ eventId: id, kind: "decision", decision: "cache" })];
  expect((await ingestYouTubeUsage("pc_a", rows)).acknowledged).toEqual([id, id]); const summary = await youtubeUsageSummary(); expect(summary.totals.attempts).toBe(0); expect(summary.droppedEvents).toBe(1);
});
it("repairs an invalid persisted record before upload without archiving or retransmitting its sensitive raw fields", async () => {
  const f = runtime(); await call(f.value);
  const current = await f.store.read<{ events: YouTubeUsageEvent[] }>("current.json");
  await f.store.write("segment-" + (now - 1) + "-" + randomUUID() + ".json", { events: [{ ...current!.events[0], eventId: randomUUID(), token: "synthetic-disk-secret" }, { ...current!.events[0], eventId: randomUUID(), method: "future-unsupported-method" }] });
  await f.value.flush(); advance(); await f.value.flush();
  expect(await pending(f.store)).toHaveLength(0); expect(JSON.stringify(f.sent)).not.toContain("synthetic-disk-secret");
  const localFiles = await readdir(f.store.dir); for (const name of localFiles.filter(name => name.endsWith(".json"))) expect(await readFile(path.join(f.store.dir, name), "utf8")).not.toContain("synthetic-disk-secret");
  expect(f.value.status().droppedEvents).toBe(2); const summary = await youtubeUsageSummary(); expect(summary.droppedEvents).toBe(2); expect(summary.totals.attempts).toBe(1); expect(summary.usedUnits).toBe(1);
});
it("retries sanitized local recovery after metadata failure and restart without losing or recounting the gap", async () => {
  const f = runtime(); await call(f.value); const name = "segment-" + (now - 1) + "-" + randomUUID() + ".json";
  await f.store.write(name, { events: [{ ...event(), token: "synthetic-disk-secret" }] });
  const write = Store.prototype.write; let fail = true;
  vi.spyOn(Store.prototype, "write").mockImplementation(async function (this: Store, target, value) { if (fail && this.dir === f.store.dir && target === "metadata.json" && (value as Record<string, unknown>).recoveredSegments) { fail = false; throw new Error("Synthetic recovery metadata failure"); } return write.call(this, target, value); });
  await f.value.flush(); expect(f.value.status().logFailed).toBe(true); expect(f.sent).toHaveLength(0); expect(await readFile(path.join(f.store.dir, name), "utf8")).not.toContain("synthetic-disk-secret");
  const restarted = runtime(); advance(); await restarted.value.flush(); advance(); await restarted.value.flush(); expect(await pending(restarted.store)).toHaveLength(0); expect(restarted.value.status().droppedEvents).toBe(1); expect((await youtubeUsageSummary()).droppedEvents).toBe(1); expect((await youtubeUsageSummary()).totals.attempts).toBe(1);
});
it("counts a repaired current segment once when rotating it to immutable pending storage", async () => {
  const f = runtime(); await f.store.write("current.json", { events: [{ token: "synthetic-disk-secret" }] });
  await f.value.flush(); expect(await pending(f.store)).toHaveLength(0); expect(f.value.status().droppedEvents).toBe(1); expect((await youtubeUsageSummary()).droppedEvents).toBe(1);
});
it("preserves a repaired gap through local capacity rotation without counting the same lost record twice", async () => {
  const f = runtime(); await f.store.write("current.json", { events: [{ token: "synthetic-disk-secret" }] });
  const offline = new AgentYouTubeUsage({ session: "synthetic-session", post: async () => { throw new Error("Offline"); } } as unknown as Transport, { store: f.store, now: () => now, maxBytes: 1 }); runtimes.push(offline);
  await offline.maintain(); expect(offline.status().droppedEvents).toBe(1); expect(await f.store.read("metadata.json")).toMatchObject({ droppedEvents: 1, pendingDropped: 1 });
});
it.each(["eventId", "sequence"] as const)("ignores duplicate %s before any receipt result or breaker mutation", async duplicate => {
  const input: YouTubeAdmit = { attemptId: randomUUID(), clientFingerprint: fingerprint, instanceId: "main", method: "channels.list", purpose: "interactive", trigger: "metadata" }; expect((await admitYouTube("pc_a", input)).allowed).toBe(true);
  const original = event({ attemptId: randomUUID() }); await ingestYouTubeUsage("pc_a", [original]);
  const replay = { ...original, attemptId: input.attemptId, kind: "finish" as const, outcome: "failed" as const, errorCode: "quotaExceeded" as const, ...(duplicate === "eventId" ? { bootId: randomUUID(), sequence: 2 } : { eventId: randomUUID() }) };
  expect((await ingestYouTubeUsage("pc_a", [replay])).acknowledged).toEqual([replay.eventId]); const state = await readYouTubeUsage(); expect(youtubeDay(state).receipts[input.attemptId].result).toBeUndefined(); expect((await youtubeUsageSummary()).breakerUntil || 0).toBe(0); expect((await youtubeUsageSummary()).droppedEvents).toBe(1);
});
