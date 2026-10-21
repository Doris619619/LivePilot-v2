/** Agent 的 YouTube 准入及脱敏日志通道：断线关闭出站，有界分段补传不阻塞通信心跳。 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { config, dataRoot } from "@/core/config";
import { Store } from "@/core/storage";
import type { YouTubeAttempt, YouTubeRuntime, YouTubeRuntimeEvent } from "@/core/youtube/usage";
import { nextQuotaMidnight } from "@/core/live-chat/policy";
import { AppError } from "@/core/errors";
import { youtubeUsageEventSchema, youtubeCost, type YouTubeAdmission, type YouTubeUsageEvent, type YouTubeResult } from "@/shared/youtube-usage";
import type { Transport } from "./transport";
type Recovery = { id: string; droppedEvents: number };
type Segment = { events: YouTubeUsageEvent[]; recovery?: Recovery };
type Metadata = { breakerUntil: number; droppedEvents: number; pendingDropped?: number; lastSyncedAt?: number; recoveredSegments?: Record<string, string> };
type Options = { store?: Store; now?: () => number; maxBytes?: number; retentionMs?: number };
const MINUTE = 60_000;
export class AgentYouTubeUsage implements YouTubeRuntime {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly bootId = randomUUID();
  private sequence = 0;
  private connected = false;
  private epoch = 0;
  private closing = false;
  private writes: Promise<unknown> = Promise.resolve();
  private flushing?: Promise<void>;
  private maintenance?: Promise<void>;
  private nextMaintenance = 0;
  private metadata?: Metadata;
  private nextFlush = 0;
  private failures = 0;
  private lost = 0;
  private decisions = new Map<string, YouTubeRuntimeEvent & { count?: number }>();
  private waits = new Map<string, { until: number; value: YouTubeAdmission }>();
  private logFailed = false;
  private permits = new WeakMap<YouTubeAdmission, number>();
  /** 存储只位于 Agent 自有日志目录；测试可注入独立目录和时钟。 */
  constructor(private transport: Transport, private options: Options = {}) {
    this.store = options.store || new Store(path.join(dataRoot(), "agent", "youtube-usage")); this.now = options.now || Date.now;
  }
  /** 每次握手重新校验能力；旧 Cloud 仍能连设备，但不能放行未保护的 Google 操作。 */
  connect(capabilities: string[]) { this.connected = capabilities.includes("youtube-quota-v1") && capabilities.includes("youtube-usage-v1"); this.epoch++; this.waits.clear(); this.nextFlush = 0; }
  /** 同步关闭出站；进行中的 Cloud 准入即使迟到成功，也不再转成 Google 请求。 */
  disconnect() { this.connected = false; this.epoch++; }
  /** 真正出站前同步核对原准入所属连接，日志落盘期间断线或换会话不能继续出站。 */
  canSend(admission: YouTubeAdmission) { return this.connected && !this.closing && !!this.transport.session && this.permits.get(admission) === this.epoch; }
  /** 只暴露安全故障计数，不影响 OBS 和心跳是否在线。 */
  status() { return { logFailed: this.logFailed, droppedEvents: (this.metadata?.droppedEvents || 0) + this.lost, lastSyncedAt: this.metadata?.lastSyncedAt, protected: this.connected }; }
  /** 进程内串行修改日志文件；网络补传不会持有此队列。 */
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.writes.then(action); this.writes = next.catch(() => {}); return next; }
  /** 持久配额拒绝跨进程重启保留；文件损坏不能伪装成新的空账本。 */
  private async load() {
    if (!this.metadata) this.metadata = await this.store.read<Metadata>("metadata.json") || { breakerUntil: 0, droppedEvents: 0 };
    return this.metadata;
  }
  /** 缺口先随安全分段落盘，再按回执累计；元数据失败后重读同段不会漏记或重复累计。 */
  private async countRecovery(name: string, recovery: Recovery) {
    const metadata = await this.load(); if (metadata.recoveredSegments?.[name] === recovery.id) return;
    const next = { ...metadata, droppedEvents: metadata.droppedEvents + recovery.droppedEvents, recoveredSegments: { ...metadata.recoveredSegments, [name]: recovery.id } };
    await this.store.write("metadata.json", next); this.metadata = next;
  }
  /** 磁盘条目再次 strict 校验；坏条只留下新生成的缺口，不上传、复制或归档原始敏感字段。 */
  private async readSegment(name: string): Promise<Segment | null> {
    const raw = await this.store.read<unknown>(name); if (raw === null) return null;
    const object = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const rows = Array.isArray(object.events) ? object.events : [undefined]; const events: YouTubeUsageEvent[] = []; let droppedEvents = 0;
    for (const row of rows) { const parsed = youtubeUsageEventSchema.safeParse(row); if (parsed.success) events.push(parsed.data); else droppedEvents++; }
    const marker = object.recovery && typeof object.recovery === "object" ? object.recovery as Record<string, unknown> : undefined;
    const prior = marker && typeof marker.id === "string" && Number.isSafeInteger(marker.droppedEvents) && Number(marker.droppedEvents) > 0 && events.some(event => event.eventId === marker.id && event.kind === "decision" && event.decision === "dropped" && event.droppedEvents === marker.droppedEvents) ? { id: marker.id, droppedEvents: Number(marker.droppedEvents) } : undefined;
    if (prior) await this.countRecovery(name, prior);
    if (!droppedEvents) return { events, ...(prior ? { recovery: prior } : {}) };
    const gap = youtubeUsageEventSchema.parse({ eventId: randomUUID(), bootId: this.bootId, sequence: this.sequence++, at: this.now(), instanceId: "main", method: "channels.list", purpose: "background", trigger: "unknown", transport: "rest", kind: "decision", decision: "dropped", droppedEvents });
    const recovery = { id: gap.eventId, droppedEvents }; const segment = { events: [...events, gap], recovery };
    await this.store.write(name, segment); await this.countRecovery(name, recovery); return segment;
  }
  /** 本机短路的阻断也带恢复时间，避免旧 Cloud/断线导致五秒一次无意义网络尝试。 */
  private denied(attempt: YouTubeAttempt, code: string, until: number): YouTubeAdmission {
    const cost = youtubeCost(attempt.method);
    return { allowed: false, attemptId: attempt.attemptId, project: "current-project", quotaDay: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now()), units: cost.units, bucket: cost.bucket, remaining: 0, backgroundRemaining: 0, activeInstances: 1, resetAt: nextQuotaMidnight(this.now()), code, blockedUntil: until };
  }
  /** 每次真实尝试由 Cloud 原子预扣；网络响应丢失只重发同一个准入 ID，不重发 Google。 */
  async admit(attempt: YouTubeAttempt): Promise<YouTubeAdmission> {
    if (!this.connected || this.closing || !this.transport.session) return this.denied(attempt, "YOUTUBE_PROTECTION_OFFLINE", this.now() + 30_000);
    let metadata: Metadata;
    try { metadata = await this.load(); } catch { return this.denied(attempt, "YOUTUBE_PROTECTION_STORAGE", this.now() + 30_000); }
    if (metadata.breakerUntil > this.now() && !attempt.method.startsWith("oauth.")) return this.denied(attempt, "YOUTUBE_DAILY_QUOTA", metadata.breakerUntil);
    const key = [attempt.instanceId, attempt.purpose, attempt.jobId || "", attempt.method].join(":");
    const wait = this.waits.get(key);
    if (wait && wait.until > this.now()) return { ...wait.value, attemptId: attempt.attemptId };
    const epoch = this.epoch; const clientId = config().clientId;
    if (!clientId) return this.denied(attempt, "YOUTUBE_PROJECT_UNMAPPED", this.now() + 30_000);
    const input = { ...attempt, clientFingerprint: createHash("sha256").update(clientId).digest("hex") };
    let value: YouTubeAdmission | undefined;
    for (let retry = 0; retry < 2; retry++) {
      try { value = await this.transport.post<YouTubeAdmission>("/api/agent/youtube-quota/admit", input); break; }
      catch (error) {
        if (error instanceof AppError && error.code === "YOUTUBE_PROTECTION_STORAGE") return this.denied(attempt, error.code, this.now() + 30_000);
        if (!(error instanceof AppError) || error.code !== "CLOUD_NETWORK" || retry) return this.denied(attempt, "YOUTUBE_PROTECTION_OFFLINE", this.now() + 30_000);
      }
    }
    if (!value || value.attemptId !== attempt.attemptId || epoch !== this.epoch || !this.connected || this.closing) return this.denied(attempt, "YOUTUBE_PROTECTION_OFFLINE", this.now() + 30_000);
    if (!value.allowed) this.waits.set(key, { until: value.code === "YOUTUBE_DAILY_QUOTA" ? value.blockedUntil || this.now() + 60_000 : Math.min(value.blockedUntil || this.now() + 30_000, this.now() + 60_000), value });
    else this.permits.set(value, epoch);
    return value;
  }
  /** 关键真实请求逐条保留；高频缓存/阻断按分钟精确合并，不能制造日志风暴。 */
  async record(event: YouTubeRuntimeEvent): Promise<void> {
    if (event.kind === "decision" && event.decision !== "dropped") {
      const key = [Math.floor(event.at / MINUTE), event.instanceId, event.accountId || "", event.jobId || "", event.method, event.purpose, event.trigger, event.decision, event.blockReason || "", event.operationId || "", event.retryCount || 0].join(":");
      const prior = this.decisions.get(key);
      if (prior) prior.count = (prior.count || 1) + (event.count || 1);
      else if (this.decisions.size < 4096) this.decisions.set(key, { ...event, count: event.count || 1 });
      else this.lost += event.count || 1;
      return;
    }
    await this.serial(async () => {
      try {
        const metadata = await this.load();
        if (event.errorCode === "quotaExceeded" || event.errorCode === "dailyLimitExceeded") { metadata.breakerUntil = nextQuotaMidnight(this.now()); await this.store.write("metadata.json", metadata); }
        await this.append(event); this.logFailed = false;
      } catch { this.logFailed = true; this.lost++; }
    });
    if (event.kind === "finish" && event.attemptId && (event.errorCode === "quotaExceeded" || event.errorCode === "dailyLimitExceeded")) {
      // 配额信号尽快传播；补传仍保留同一结果，Cloud 按 attemptId 幂等处理。
      void this.sendResult(event).catch(() => {});
    }
  }
  /** 白名单重建事件，只保存 schema 允许的数据；每段最多 256 条或 256 KiB。 */
  private async append(event: YouTubeRuntimeEvent) {
    const next = youtubeUsageEventSchema.parse({ ...event, eventId: randomUUID(), bootId: this.bootId, sequence: this.sequence++ });
    let current = await this.readSegment("current.json") || { events: [] };
    if (current.events.length >= 256 || Buffer.byteLength(JSON.stringify(current)) + Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) { await this.rotate(current); current = { events: [] }; }
    current.events.push(next); await this.store.write("current.json", current);
  }
  /** 先保存不可变段再清当前段，崩溃最多产生可去重的重复，不丢已落盘事件。 */
  private async rotate(current?: Segment) {
    const value = current || await this.readSegment("current.json");
    if (!value?.events.length) return;
    // current 的恢复回执已先计入元数据；转段只复制安全事件，不能在新文件名下再累计同一个缺口。
    await this.store.write("segment-" + this.now() + "-" + randomUUID() + ".json", { events: value.events }); await this.store.write("current.json", { events: [] });
  }
  /** 将有界积压和缺口一起落盘；只在分钟结束或退出时展开决策计数。 */
  private async flushDecisions(all = false) {
    for (const [key, event] of this.decisions) if (all || Math.floor(event.at / MINUTE) < Math.floor(this.now() / MINUTE)) { await this.append(event); this.decisions.delete(key); }
    const metadata = await this.load(); const pending = metadata.pendingDropped || 0;
    if (this.lost || pending) {
      const dropped = this.lost + pending;
      await this.append({ at: this.now(), instanceId: "main", method: "channels.list", purpose: "background", trigger: "unknown", transport: "rest", kind: "decision", decision: "dropped", droppedEvents: dropped });
      metadata.droppedEvents += this.lost; metadata.pendingDropped = 0; await this.store.write("metadata.json", metadata); this.lost = 0;
    }
  }
  /** 只枚举自己生成的分段名；按时间淘汰时保留累计缺口，不误删其他运行数据。 */
  private async segments() {
    const names = (await readdir(this.store.dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter(name => /^(?:segment|archive)-\d+-[a-f0-9-]{36}\.json$/.test(name)).sort();
    const rows = await Promise.all(names.map(async name => ({ name, ...(await stat(path.join(this.store.dir, name))) })));
    const metadata = await this.load(); const recovered = Object.fromEntries(Object.entries(metadata.recoveredSegments || {}).filter(([name]) => name === "current.json" || names.includes(name)));
    if (Object.keys(recovered).length !== Object.keys(metadata.recoveredSegments || {}).length) { const next = { ...metadata, recoveredSegments: recovered }; await this.store.write("metadata.json", next); this.metadata = next; }
    let bytes = rows.reduce((sum, row) => sum + row.size, 0);
    const removed = new Set<string>();
    for (const row of rows.sort((a, b) => Number(b.name.startsWith("archive-")) - Number(a.name.startsWith("archive-")) || a.mtimeMs - b.mtimeMs)) {
      if (row.mtimeMs >= this.now() - (this.options.retentionMs || 7 * 86400_000) && bytes <= (this.options.maxBytes || 128 * 1024 * 1024)) continue;
      if (!row.name.startsWith("archive-")) {
        const value = await this.readSegment(row.name); const count = value?.events.reduce((sum, event) => sum + (event.droppedEvents || event.count || 1), 0) || 0;
        // dropped 记录代表此前已累计的缺口；淘汰时继续向 Cloud 报告它，但本机不再重复增加同一损失。
        const newlyDropped = value?.events.reduce((sum, event) => sum + (event.kind === "decision" && event.decision === "dropped" ? 0 : event.count || 1), 0) || 0;
        const metadata = await this.load(); const next = { ...metadata, droppedEvents: metadata.droppedEvents + newlyDropped, pendingDropped: (metadata.pendingDropped || 0) + count };
        await this.store.write("metadata.json", next); this.metadata = next;
      }
      await this.store.remove(row.name); bytes -= row.size; removed.add(row.name);
    }
    return names.filter(name => name.startsWith("segment-") && !removed.has(name));
  }
  /** 即时结果只含固定分类；任何传输失败均由既有分段补传恢复。 */
  private async sendResult(event: YouTubeRuntimeEvent) {
    if (!this.connected || !event.attemptId || !event.outcome) return;
    const result: YouTubeResult = { attemptId: event.attemptId, outcome: event.outcome, durationMs: event.durationMs || 0, ...(event.httpStatus ? { httpStatus: event.httpStatus } : {}), ...(event.grpcStatus !== undefined ? { grpcStatus: event.grpcStatus } : {}), ...(event.errorCode ? { errorCode: event.errorCode } : {}), ...(event.streamBatches !== undefined ? { streamBatches: event.streamBatches } : {}), ...(event.streamMessages !== undefined ? { streamMessages: event.streamMessages } : {}) };
    await this.transport.post("/api/agent/youtube-quota/result", result);
  }
  /** 本地每分钟维护独立于 Cloud 连接，离线也执行七天期限与容量轮转；没有任何网络副作用。 */
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    if (this.closing || this.now() < this.nextMaintenance) return Promise.resolve();
    this.nextMaintenance = this.now() + MINUTE;
    this.maintenance = this.serial(async () => { await this.flushDecisions(); await this.rotate(); await this.segments(); }).catch(() => { this.logFailed = true; }).finally(() => { this.maintenance = undefined; });
    return this.maintenance;
  }
  /** 每次最多补传 64 条，Cloud 持久确认后才删除；与心跳、真实请求完全分离。 */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.connected || this.now() < this.nextFlush || this.closing) return Promise.resolve();
    this.flushing = this.flushOnce().catch(() => { this.logFailed = true; this.failures++; this.nextFlush = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures)); }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  /** 网络调用不在文件串行队列里；旧确认只删除其精确 eventId，后来的日志不会被吞。 */
  private async flushOnce() {
    const item = await this.serial(async () => { await this.load(); await this.flushDecisions(); await this.rotate(); const names = await this.segments(); for (const name of names) { const segment = await this.readSegment(name); if (segment?.events.length) return { name, events: segment.events.slice(0, 64) }; } });
    this.nextFlush = this.now() + 5000;
    if (!item) return;
    const response = await this.transport.post<{ acknowledged: string[] }>("/api/agent/youtube-usage", { events: item.events });
    const sent = new Set(item.events.map(event => event.eventId)); const ack = new Set(response.acknowledged.filter(id => sent.has(id)));
    await this.serial(async () => {
      const current = await this.readSegment(item.name); if (!current) return;
      const archived = current.events.filter(event => ack.has(event.eventId));
      if (archived.length) await this.store.write("archive-" + this.now() + "-" + randomUUID() + ".json", { events: archived });
      const events = current.events.filter(event => !ack.has(event.eventId));
      if (events.length) await this.store.write(item.name, { events }); else await this.store.remove(item.name);
      const metadata = await this.load(); metadata.lastSyncedAt = this.now(); await this.store.write("metadata.json", metadata);
    });
    this.failures = 0; this.logFailed = false;
  }
  /** 停止新的准入并落盘剩余计数，不等待 Cloud 或打断已经存在的 OBS 推流。 */
  async stop() {
    this.closing = true; this.disconnect(); await Promise.all([this.flushing, this.maintenance]);
    if (!this.decisions.size && !this.metadata && !this.lost) return;
    await this.serial(async () => { try { await this.load(); await this.flushDecisions(true); await this.rotate(); } catch { this.logFailed = true; } });
  }
}
