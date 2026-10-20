/** 有界 YouTube 安全事件存储：批量去重、14天/512MiB明细及90天日汇总。 */
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { quotaDay } from "@/core/publishing/schedule";
import { nextQuotaMidnight } from "@/core/live-chat/policy";
import { AppError } from "@/core/errors";
import { youtubeUsageBatchSchema, youtubeCost, type StoredYouTubeEvent, type YouTubeUsageEvent, type YouTubeUsageQuery, type YouTubeEventsPage } from "@/shared/youtube-usage";
import { requireTarget } from "./agents";
import { requirePublishingAccount } from "./publishing-accounts";
import { transaction } from "./store";
import { youtubeUsageStore, editYouTubeUsage, youtubeDay, findYouTubeReceipts, saveArchivedYouTubeResults, type YouTubeReceiptLocation } from "./youtube-usage-store";
type Totals = { attempts: number; failures: number; cacheHits: number; blocked: number };
type Summary = { totals: Totals; byMethod: Record<string, number>; ranking: Record<string, { attempts: number; units: number }>; instances?: Record<string, { agentId: string; instanceId: string; attempts: number; units: number }>; minutes: Record<string, { attempts: number; units: number }>; droppedEvents: number; lastSyncedAt?: number };
type Segment = { name: string; at: number; size: number; count: number };
type EventIndex = { segments: Segment[]; seen: Record<string, number>; summaries: Record<string, Summary>; droppedEvents: number };
const reconciled = new Map<string, number>();
/** 新日汇总不依赖明细保留期限，精确计数不做采样。 */
function emptySummary(): Summary { return { totals: { attempts: 0, failures: 0, cacheHits: 0, blocked: 0 }, byMethod: {}, ranking: {}, minutes: {}, droppedEvents: 0 }; }
/** 所有日志文件名由 Cloud 生成；设备事件 UUID 仅用于去重。 */
async function readIndex(): Promise<EventIndex> { return await youtubeUsageStore().read<EventIndex>("events-index.json") || { segments: [], seen: {}, summaries: {}, droppedEvents: 0 }; }
/** 日汇总按一次真实开始计请求和名义成本，finish不再次计费。 */
function accumulate(index: EventIndex, event: StoredYouTubeEvent) {
  const s = index.summaries[event.quotaDay] ||= emptySummary(); const count = event.kind === "decision" ? event.count || 1 : 1;
  if (event.kind === "start") {
    s.totals.attempts++; const units = event.estimatedUnits || 0;
    s.byMethod[event.method] = (s.byMethod[event.method] || 0) + units;
    const rank = s.ranking[event.agentId] ||= { attempts: 0, units: 0 }; rank.attempts++; rank.units += units;
    s.instances ||= {}; const instance = s.instances[event.agentId + ":" + event.instanceId] ||= { agentId: event.agentId, instanceId: event.instanceId, attempts: 0, units: 0 }; instance.attempts++; instance.units += units;
    const minute = s.minutes[Math.floor(event.at / 60_000) * 60_000] ||= { attempts: 0, units: 0 }; minute.attempts++; minute.units += units;
  }
  if (event.kind === "finish" && ["failed", "unknown"].includes(event.outcome || "")) s.totals.failures++;
  if (event.kind === "decision" && event.decision === "cache") s.totals.cacheHits += count;
  if (event.kind === "decision" && event.decision === "blocked") s.totals.blocked += count;
  if (event.droppedEvents) { s.droppedEvents += event.droppedEvents; index.droppedEvents += event.droppedEvents; }
  s.lastSyncedAt = event.receivedAt;
}
/** 轮转先维持计数，再移除明细；达到大小上限的缺失会在管理员页面显式显示。 */
async function rotate(index: EventIndex, now: number) {
  const store = youtubeUsageStore(); let bytes = index.segments.reduce((sum, s) => sum + s.size, 0) + Buffer.byteLength(JSON.stringify(index));
  // 分段已落盘但索引尚未提交的崩溃窗口不能留下永久孤儿文件；Agent未获ack仍会重传。
  if (!reconciled.has(store.dir) || now - reconciled.get(store.dir)! > 60_000) { const known = new Set(index.segments.map(s => s.name)); for (const entry of await readdir(store.dir, { withFileTypes: true })) if (entry.isFile() && /^events-\d+-[a-f0-9]{20}\.json$/.test(entry.name) && !known.has(entry.name)) await unlink(path.join(store.dir, entry.name)); reconciled.set(store.dir, now); }
  while (index.segments.length && (index.segments[0].at < now - 14 * 86400_000 || bytes > 512 * 1024 ** 2)) {
    const segment = index.segments.shift()!; bytes -= segment.size;
    if (segment.at >= now - 14 * 86400_000) { index.droppedEvents += segment.count; for (const s of Object.values(index.summaries)) if (s.lastSyncedAt && s.lastSyncedAt >= segment.at) s.droppedEvents += segment.count; }
    await unlink(path.join(store.dir, segment.name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  const seenCutoff = now - 14 * 86400_000; for (const key of Object.keys(index.seen)) if (index.seen[key] < seenCutoff) delete index.seen[key];
  const summaryCutoff = quotaDay(now - 90 * 86400_000); for (const key of Object.keys(index.summaries)) if (key < summaryCutoff) delete index.summaries[key];
}
/** 认证身份覆盖设备字段；strict schema 拒绝携带任何原始文本、URL 或凭据。 */
export async function ingestYouTubeUsage(agentId: string, raw: YouTubeUsageEvent[]) {
  const { events } = youtubeUsageBatchSchema.parse({ events: raw }); const now = Date.now();
  for (const event of events) { await requireTarget(agentId, event.instanceId); if (event.accountId) await requirePublishingAccount(agentId, event.instanceId, event.accountId); if (event.at > now + 300_000) throw new AppError("INPUT", "事件时间超过允许偏差。", 400); }
  const verified = events.every(event => event.kind === "decision") ? new Set(events.map(event => event.eventId)) : await editYouTubeUsage(async state => {
    const found = new Set<string>(); const receipts = await findYouTubeReceipts(state, events.flatMap(event => event.attemptId ? [event.attemptId] : [])); const changed: YouTubeReceiptLocation[] = [];
    for (const event of events) {
      if (event.kind === "decision") { found.add(event.eventId); continue; }
      const location = event.attemptId ? receipts.get(event.attemptId) : undefined; const receipt = location?.receipt;
      if (!receipt || receipt.agentId !== agentId || receipt.input.instanceId !== event.instanceId || receipt.input.accountId !== event.accountId || receipt.input.method !== event.method || !receipt.admission.allowed) continue;
      found.add(event.eventId);
      if (event.kind === "finish" && event.outcome) {
        receipt.result ||= { attemptId: receipt.input.attemptId, outcome: event.outcome, durationMs: event.durationMs || 0, httpStatus: event.httpStatus, grpcStatus: event.grpcStatus, errorCode: event.errorCode };
        const day = youtubeDay(state); if (["quotaExceeded", "dailyLimitExceeded"].includes(event.errorCode || "") && quotaDay(event.at) === day.day) day.breakerUntil = nextQuotaMidnight(now);
        if (location?.archiveDay) changed.push(location);
      }
    }
    if (changed.length) await saveArchivedYouTubeResults(changed); return found;
  });
  const store = youtubeUsageStore();
  return transaction(store, async () => {
    const index = await readIndex(); const fresh: StoredYouTubeEvent[] = [];
    for (const event of events) {
      const key = agentId + ":" + event.eventId; const sequenceKey = agentId + ":" + event.bootId + ":" + event.sequence; if (index.seen[key] || index.seen[sequenceKey]) continue;
      index.seen[key] = now; index.seen[sequenceKey] = now;
      const safe = verified.has(event.eventId) ? event : { ...event, kind: "decision" as const, decision: "dropped" as const, droppedEvents: (event.droppedEvents || 0) + 1 };
      const cost = youtubeCost(safe.method); const value: StoredYouTubeEvent = { ...safe, agentId, project: "current-project", receivedAt: now, estimatedUnits: safe.kind === "start" && cost.bucket === "general" ? cost.units : null, quotaDay: quotaDay(safe.at) };
      fresh.push(value); accumulate(index, value);
    }
    if (fresh.length) { const name = "events-" + now + "-" + createHash("sha256").update(fresh.map(e => e.eventId).join(":")).digest("hex").slice(0, 20) + ".json"; await store.write(name, fresh); index.segments.push({ name, at: now, size: Buffer.byteLength(JSON.stringify(fresh)), count: fresh.length }); }
    await rotate(index, now); await store.write("events-index.json", index);
    return { acknowledged: events.map(e => e.eventId) };
  }, "youtube-events.lock");
}
/** 汇总仅从持久索引读取；保留90天，无网络副作用。 */
export async function youtubeEventSummary(day: string) {
  const index = await readIndex(); const s = index.summaries[day] || emptySummary();
  return { totals: s.totals, byMethod: s.byMethod, ranking: Object.entries(s.ranking).map(([key, value]) => ({ key, ...value })).sort((a, b) => b.units - a.units), instanceRanking: Object.values(s.instances || {}).sort((a, b) => b.units - a.units), minutes: Object.entries(s.minutes).map(([minute, value]) => ({ minute: Number(minute), ...value })).sort((a, b) => a.minute - b.minute), lastSyncedAt: s.lastSyncedAt, incomplete: s.droppedEvents > 0, droppedEvents: s.droppedEvents };
}
/** 复用筛选表达式，确保网页与导出范围一致。 */
function matches(event: StoredYouTubeEvent, query: YouTubeUsageQuery) {
  return (!query.day || query.day === event.quotaDay) && (!query.agentId || query.agentId === event.agentId) && (!query.instanceId || query.instanceId === event.instanceId) && (!query.method || query.method === event.method) && (!query.purpose || query.purpose === event.purpose) && (!query.outcome || query.outcome === event.outcome) && (query.from === undefined || event.at >= query.from) && (query.to === undefined || event.at <= query.to);
}
/** 明细在14天内分页；分页游标只包含时间与UUID，不含磁盘路径。 */
export async function youtubeEvents(query: YouTubeUsageQuery, exportAll = false): Promise<YouTubeEventsPage> {
  const store = youtubeUsageStore(); const index = await readIndex(); const limit = exportAll ? 100000 : Math.min(500, Math.max(1, query.limit || 100)); let selected: StoredYouTubeEvent[] = []; let missing = 0;
  const [cursorAt, cursorId] = query.cursor?.split(":") || [];
  for (const segment of index.segments) {
    const events = await store.read<StoredYouTubeEvent[]>(segment.name); if (!events) missing += segment.count;
    for (const event of events || []) if (matches(event, query) && (!query.cursor || event.at < Number(cursorAt) || event.at === Number(cursorAt) && event.eventId.localeCompare(cursorId) < 0)) selected.push(event);
    // 每个分段后只保留当前页及一个next游标证据，避免查看512MiB日志时撑爆服务内存。
    selected = selected.sort((a, b) => b.at - a.at || b.eventId.localeCompare(a.eventId)).slice(0, limit + 1);
  }
  const page = selected.slice(0, limit); const last = page.at(-1);
  return { events: page, ...(last && selected.length > limit ? { nextCursor: last.at + ":" + last.eventId } : {}), incomplete: index.droppedEvents > 0 || missing > 0 || exportAll && selected.length > limit, droppedEvents: index.droppedEvents + missing };
}
/** 导出逐段读取，不把512MiB明细一次放入内存；轮转竞争导致的缺口在尾部元数据报告。 */
export async function* streamYouTubeEvents(query: YouTubeUsageQuery): AsyncGenerator<{ event?: StoredYouTubeEvent; metadata?: { incomplete: boolean; droppedEvents: number } }> {
  const store = youtubeUsageStore(); const index = await readIndex(); const seen = new Set<string>(); let missing = 0;
  yield { metadata: { incomplete: index.droppedEvents > 0, droppedEvents: index.droppedEvents } };
  for (const segment of index.segments) {
    const events = await store.read<StoredYouTubeEvent[]>(segment.name); if (!events) { missing += segment.count; continue; }
    for (const event of events) { const key = event.agentId + ":" + event.eventId; if (!seen.has(key) && matches(event, query)) { seen.add(key); yield { event }; } }
  }
  yield { metadata: { incomplete: index.droppedEvents > 0 || missing > 0, droppedEvents: index.droppedEvents + missing } };
}
