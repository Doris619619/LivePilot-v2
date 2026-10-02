/** 单台 Agent 的持久发布运行器；短指令与长上传分离，重启先探测旧 session。 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { config, dataRoot } from "../config";
import { seal, unseal, Store } from "../storage";
import { AppError, safeError, sleep } from "../errors";
import type { Service } from "../service";
import { VideoApi, VideoApiError, type VideoPort, type VideoResource } from "../youtube/video-api";
import { type JobSpec, type PublishingReport, type MediaAsset, type PackageBatch, jobSpecSchema, publishingTerminal } from "@/shared/publishing";
import { PublishingStore } from "./storage";
import { validateAsset, resolvePublishingThumbnail } from "./assets";
import { publishingMetadata } from "./metadata";
import { publishingRoot, resolvePackageFile, validatePackage } from "./packages";
import { preparePackageUpload, validatePreparedUpload } from "./render";
import { archivePublishingBatch } from "./archive";
import { effectivePublishAt } from "./schedule";
import type { YouTubeAuth } from "../youtube/auth";
type FinalUpload = { asset: MediaAsset; relativePath: string; sha256: string };
type Entry = { preparedSequence?: number; finalUpload?: FinalUpload; spec: JobSpec; report: PublishingReport; acknowledged?: number; session?: string; sha256?: string; finalChunkPossible?: boolean; thumbnailDone?: boolean; playlistsDone: string[]; finalized?: boolean; scheduleRevisionPending?: boolean; reschedulePreviousAt?: string; expiredData?: boolean; failures: number; resumeState?: PublishingReport["state"] };
type Options = { requirePreparedAcknowledgement?: boolean; store?: PublishingStore; now?: () => number; api?: (spec: JobSpec) => VideoPort; accountAuth?: (accountId: string) => YouTubeAuth; live?: () => boolean; charge?: (job: JobSpec, units: number, upload: boolean) => Promise<void>; metadata?: typeof publishingMetadata };
/** RFC3339 的不同等价格式按同一时刻比较，避免 .000Z 与 Z 导致误判排期。 */
function sameMoment(a?: unknown, b?: string) { return typeof a === "string" && !!b && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b); }
export class PublishingRunner {
  private entries = new Map<string, Entry>(); private loaded = false; private writes: Promise<unknown> = Promise.resolve(); private active = new Map<string, Promise<void>>(); private aborters = new Map<string, AbortController>(); private stopped = false;
  private archives = new Map<string, Promise<unknown>>();
  private purging = new Set<string>();
  private accepting: Promise<unknown> = Promise.resolve(); private loading?: Promise<void>;
  readonly storage: PublishingStore; private now: () => number;
  /** 每台物理机器创建一次；API 与时钟可注入以验证崩溃恢复而不访问真实频道。 */
  constructor(private services: Map<string, Service>, private options: Options = {}) { this.storage = options.store || new PublishingStore(path.join(dataRoot(), "agent", "publishing")); this.now = options.now || Date.now; }
  /** 初次启动仅载入加密日志，不自动重放旧 HTTP 操作。 */
  async load() { if (this.loaded) return; this.loading ??= (async () => { const value = await this.storage.read<string>("entries.enc"); if (value) for (const entry of unseal<Entry[]>(value)) { jobSpecSchema.parse(entry.spec); this.entries.set(entry.spec.id, entry); } this.loaded = true; })(); try { await this.loading; } finally { this.loading = undefined; } }
  /** 串行落盘最新完整日志，包含所有尚未被 Cloud 确认的报告。 */
  private save() { const next = this.writes.then(() => this.storage.write("entries.enc", seal([...this.entries.values()]))); this.writes = next.catch(() => {}); return next; }
  /** 幂等接收任务修订；目标和素材不可通过相同 jobId 偷换。 */
  async apply(value: JobSpec) {
    const next = this.accepting.then(() => this.applyOnce(value)); this.accepting = next.catch(() => {}); return next;
  }
  /** 串行检查版本和落盘，防止同时接收两条修订时旧版本覆盖新版本。 */
  private async applyOnce(value: JobSpec) {
    await this.load(); const spec = jobSpecSchema.parse(value); if (this.purging.has(this.authorizationKey(spec))) throw new AppError("CLEANUP", "发布账号正在清理授权。"); if (spec.contentPackage && this.archives.has(spec.contentPackage.batchName)) throw new AppError("ARCHIVE_BUSY", "批次正在归档，请稍后重试。"); const old = this.entries.get(spec.id);
    if (old && spec.revision <= old.spec.revision) { if (spec.revision === old.spec.revision && JSON.stringify(spec) !== JSON.stringify(old.spec)) throw new AppError("REQUEST", "相同任务版本包含不同输入。"); return { ok: true }; }
    if (old && (old.spec.batchId !== spec.batchId || old.spec.asset.version !== spec.asset.version || old.spec.contentPackage?.version !== spec.contentPackage?.version || old.spec.owner !== spec.owner || JSON.stringify(old.spec.profile) !== JSON.stringify(spec.profile))) throw new AppError("REQUEST", "任务修订不能替换素材、频道或配置快照。");
    if (old) {
      const rescheduled = old.spec.originalPublishAt !== spec.originalPublishAt;
      const rescheduleRejected = rescheduled && (publishingTerminal(old.report.state) || old.report.state === "needs_attention");
      if (rescheduled && !rescheduleRejected && old.report.videoId) old.reschedulePreviousAt ??= old.report.effectivePublishAt || old.spec.originalPublishAt;
      old.spec = spec; if (spec.desired !== "run") this.aborters.get(spec.id)?.abort(); old.report.revision = spec.revision;
      if (rescheduleRejected) { old.report.message = old.report.state === "published" ? "视频已公开，改期未应用。" : "任务已结束或需要人工处理，改期未应用。"; if (["published", "completed"].includes(old.report.state)) old.report.nextAttemptAt = this.now() + 25 * 86400_000; }
      else {
        if (spec.desired !== "run" && old.report.state === "needs_attention") old.report.state = old.report.videoId ? "processing" : "ready";
        old.report.nextAttemptAt = undefined;
        if (rescheduled && old.report.videoId) {
          old.finalized = false; old.scheduleRevisionPending = true;
          if (old.report.state === "paused" || old.report.state === "retry_wait") old.resumeState = old.resumeState === "processing" ? "processing" : "finalizing";
          else if (old.report.state !== "processing") old.report.state = "finalizing";
        }
        if (spec.desired === "run" && ["paused", "needs_attention", "retry_wait"].includes(old.report.state)) { old.report.state = old.resumeState || (old.report.videoId ? "processing" : "ready"); old.report.nextAttemptAt = undefined; old.report.message = undefined; }
        if (spec.desired === "run" && ["scheduled", "processing", "published", "completed"].includes(old.report.state)) old.report.nextAttemptAt = this.now();
      }
      if (old.report.state === "published" && spec.desired === "cancel") old.report.message = "视频已公开，取消未应用。";
      old.report.sequence++; old.report.updatedAt = this.now();
      // 旧修订报告可能被Cloud丢弃；新修订在创建会话前重新确认最终文件描述。
      if (old.finalUpload && !old.session && !old.report.videoId) old.preparedSequence = old.report.sequence;
    } else this.entries.set(spec.id, { spec, report: { id: spec.id, revision: spec.revision, sequence: 1, state: "ready", offset: 0, total: spec.asset.size, updatedAt: this.now() }, playlistsDone: [], failures: 0 });
    await this.save(); return { ok: true };
  }
  /** 只有新报告被精确确认后才丢弃待报告标记，旧确认不能吞掉新进度。 */
  async acknowledge(values: { id: string; sequence: number }[]) { await this.load(); for (const v of values) { const entry = this.entries.get(v.id); if (entry && v.sequence <= entry.report.sequence) entry.acknowledged = Math.max(entry.acknowledged || 0, v.sequence); } await this.save(); }
  /** 公开报告只含状态和最终文件指纹，不包含 session URI、本机文件路径或 Token。 */
  async reports() { await this.load(); return [...this.entries.values()].filter(e => e.report.sequence > (e.acknowledged || 0)).slice(0, 32).map(e => structuredClone(e.report)); }
  /** 新授权必须仍属于尚未完成任务的频道。 */
  async expectedChannel(instanceId: string, accountId?: string) { await this.load(); return [...this.entries.values()].find(e => e.spec.profile.instanceId === instanceId && e.spec.profile.accountId === accountId && !publishingTerminal(e.report.state))?.spec.profile.channelId; }
  /** 已验证 Hash 按文件版本缓存；索引读取不重新打开视频流。 */
  async assetHashes(instanceId: string) { await this.load(); return Object.fromEntries([...this.entries.values()].filter(e => e.spec.profile.instanceId === instanceId && e.sha256).map(e => [e.spec.asset.version, e.sha256!])); }
  /** 改变状态后先持久化；远端副作用必须发生在对应检查点之后。 */
  private async update(entry: Entry, change: Partial<PublishingReport>) { Object.assign(entry.report, change, { sequence: entry.report.sequence + 1, revision: entry.spec.revision, updatedAt: this.now() }); await this.save(); }
  /** 旧排期请求返回后不得确认新修订；下一 tick 用相同 videoId 回读并应用当前意图。 */
  private currentFinalization(entry: Entry, revision: number) { return entry.spec.revision === revision && entry.spec.desired === "run" && !this.stopped; }
  /** 视频已公开时保留远端事实，并明确报告改期未应用；绝不把它改回私密。 */
  private async alreadyPublic(entry: Entry, cancellation = false) {
    const rejected = entry.scheduleRevisionPending || !!entry.reschedulePreviousAt;
    if (rejected && entry.reschedulePreviousAt) entry.report.effectivePublishAt = entry.reschedulePreviousAt;
    entry.scheduleRevisionPending = false; entry.reschedulePreviousAt = undefined;
    await this.update(entry, { state: "published", observedPrivacy: "public", remoteCheckedAt: this.now(), nextAttemptAt: this.now() + 25 * 86400_000, message: cancellation ? "视频已公开，取消未应用。" : rejected ? "视频已公开，改期未应用。" : undefined });
  }
  /** 旧取消可能已生效；先回读原视频，再恢复最新意图，不能替新修订确认取消或错误。 */
  private async supersededCancellation(entry: Entry, api: VideoPort) {
    if (this.stopped) return;
    let current: VideoResource | undefined;
    try { if (entry.report.videoId) current = (await api.list([entry.report.videoId]))[0]; }
    catch { /* 旧请求错误不污染新修订；下面保留检查点，等待重新核对。 */ }
    if (this.stopped) return;
    if (current?.status?.privacyStatus === "public") { await this.alreadyPublic(entry, true); return; }
    entry.finalized = false;
    entry.scheduleRevisionPending = entry.spec.profile.scheduled;
    const phase = current?.processingDetails?.processingStatus === "processing" || current?.status?.uploadStatus === "uploaded" ? "processing" : entry.report.videoId ? "finalizing" : "ready";
    entry.resumeState = phase;
    const known = !entry.report.videoId || !!current?.status?.privacyStatus;
    await this.update(entry, { state: entry.spec.desired === "pause" ? "paused" : known ? phase : "retry_wait", nextAttemptAt: entry.spec.desired === "pause" ? undefined : known ? this.now() : this.now() + 30_000, message: known ? undefined : "旧取消结果等待核对，保留原视频并等待应用最新设置。", ...(current ? { observedPrivacy: current.status?.privacyStatus, remoteCheckedAt: this.now(), processingStatus: current.processingDetails?.processingStatus } : {}) });
  }
  /** 对真实频道身份做独立检查，不依赖任何 OBS readiness。 */
  private async checkChannel(entry: Entry) {
    if (this.options.api && !this.services.size) return;
    const token = await this.auth(entry).tokens();
    if (!token || token.channelId !== entry.spec.profile.channelId) throw new AppError("CHANNEL", "任务频道与当前授权不一致，请连接原频道。");
  }
  /** 每次 API admission 使用当前项目策略；不在 Cloud 保存 Google 凭据。 */
  private api(entry: Entry) { if (this.options.api) return this.options.api(entry.spec); return new VideoApi(this.auth(entry), (units, upload) => { if (!this.options.charge) throw new AppError("VIDEO_QUOTA", "发布配额尚未连接 Cloud。", 503); return this.options.charge(entry.spec, units, upload); }); }
  /** 新任务只使用明确账号的独立授权；旧任务继续原实例授权，不进行隐式回退。 */
  private auth(entry: Entry) { if (entry.spec.profile.accountId) { if (!this.options.accountAuth) throw new AppError("ACCOUNT", "发布账号授权模块尚未连接。", 409); return this.options.accountAuth(entry.spec.profile.accountId); } const app = this.services.get(entry.spec.profile.instanceId); if (!app) throw new AppError("INSTANCE", "发布实例不存在。"); return app.auth; }
  /** 本地清理锁标识授权上下文；同设备多个发布账号与旧直播实例互不占用。 */
  private authorizationKey(spec: JobSpec) { return spec.profile.accountId ? "account:" + spec.profile.accountId : "legacy:" + spec.profile.instanceId; }
  /** 后台一次 tick 只启动允许的上传数量；processing/scheduled 查询统一按频道批量执行。 */
  async tick() {
    await this.load(); if (this.stopped) return;
    for (const e of this.entries.values()) if (!this.active.has(e.spec.id) && !e.expiredData && e.report.remoteCheckedAt && e.report.remoteCheckedAt < this.now() - 30 * 86400_000) { const terminal = publishingTerminal(e.report.state); e.expiredData = true; e.session = undefined; e.playlistsDone = []; e.resumeState = undefined; await this.update(e, { state: terminal ? e.report.state : "needs_attention", videoId: undefined, metadata: undefined, processingStatus: undefined, observedPrivacy: undefined, nextAttemptAt: undefined, message: terminal ? "过期 YouTube 观察数据已清除，执行结果保留。" : "过期 YouTube 数据已清除；请在 Studio 核对，本任务禁止重新上传。" }); }
    const entries = [...this.entries.values()].sort((a, b) => (a.spec.originalPublishAt || "").localeCompare(b.spec.originalPublishAt || "") || a.spec.index - b.spec.index);
    for (const entry of entries) {
      if (this.purging.has(this.authorizationKey(entry.spec)) || this.active.has(entry.spec.id) || entry.report.state === "needs_attention" || entry.spec.desired === "pause" && entry.report.state === "paused" || entry.spec.desired === "cancel" && ["cancelled", "published"].includes(entry.report.state) || entry.spec.desired === "run" && (publishingTerminal(entry.report.state) || ["scheduled", "processing", "paused"].includes(entry.report.state))) continue;
      if (entry.report.nextAttemptAt && entry.report.nextAttemptAt > this.now()) continue;
      if (this.active.size >= entry.spec.policy.concurrency) break;
      const promise = this.execute(entry).catch(e => this.failure(entry, e)).finally(() => { this.active.delete(entry.spec.id); this.aborters.delete(entry.spec.id); });
      this.active.set(entry.spec.id, promise); void promise.catch(() => {});
    }
    await this.poll(entries);
  }
  /** 单步操作失败保留当前阶段；网络和配额错误回退重试，永久拒绝等待人工。 */
  private async failure(entry: Entry, error: unknown) {
    if (!entry.resumeState) entry.resumeState = entry.report.state;
    entry.failures++;
    if (entry.spec.desired === "pause") { await this.update(entry, { state: "paused", nextAttemptAt: undefined, message: undefined }); return; }
    if (entry.spec.desired === "cancel" && (error instanceof Error && error.name === "AbortError" || error instanceof AppError && error.code === "RENDER_ABORTED")) { await this.update(entry, { state: "retry_wait", nextAttemptAt: this.now() }); return; }
    const retry = error instanceof VideoApiError ? error.retryable : error instanceof AppError && (["RENDER_WAIT", "VIDEO_QUOTA", "AGENT_NETWORK", "AGENT_TIMEOUT", "CLOUD_NETWORK", "GOOGLE_NETWORK", "GOOGLE_UNAVAILABLE", "YOUTUBE_QUOTA"].includes(error.code) || error.code === "CLOUD_REQUEST" && error.status >= 500);
    await this.update(entry, { state: retry || this.stopped ? "retry_wait" : "needs_attention", authorizationInvalid: error instanceof AppError && ["GOOGLE_AUTH", "YOUTUBE_AUTH"].includes(error.code) || undefined, message: safeError(error).slice(0, 500), nextAttemptAt: retry ? this.now() + Math.max(error instanceof VideoApiError ? error.retryAfterMs : 0, Math.min(1_800_000, 30_000 * 2 ** Math.min(entry.failures - 1, 6))) : undefined });
  }
  /** 续传前先核对远端 session；末块结果不明时从不盲目重新开始。 */
  private async execute(entry: Entry) {
    if (entry.expiredData) throw new AppError("DATA_EXPIRED", "API 数据已清除；请在 Studio 人工核对，不会创建第二次上传。");
    if (entry.spec.desired === "pause") { if (entry.report.state !== "paused") { entry.resumeState = entry.report.state === "retry_wait" ? entry.resumeState : entry.report.state; await this.update(entry, { state: "paused", nextAttemptAt: undefined }); } return; }
    if (entry.spec.contentPackage && !entry.finalUpload && !entry.report.videoId && (entry.session || entry.finalChunkPossible)) throw new AppError("UPLOAD_UNCERTAIN", "最终文件检查点缺失，禁止重新生成和重复上传。");
    const api = this.api(entry); await this.checkChannel(entry);
    if (entry.spec.desired === "cancel") {
      if (entry.report.state === "cancelled") return;
      const cancellingRevision = entry.spec.revision;
      /** 远端探测和取消的迟到结果只属于发起时的修订；停止后留待下次启动核对。 */
      const currentCancellation = () => entry.spec.revision === cancellingRevision && entry.spec.desired === "cancel" && !this.stopped;
      try {
        if (!entry.report.videoId && entry.finalChunkPossible) { if (entry.session) await this.acceptProbe(entry, await api.probe(entry.session, this.uploadAsset(entry).size), api); else await this.acceptProbe(entry, { offset: 0, expired: true }, api); if (!entry.report.videoId && entry.report.offset === this.uploadAsset(entry).size) throw new AppError("UPLOAD_UNCERTAIN", "末块结果尚未确认，未将任务标为可重新排队。请在 Studio 核对。"); }
        if (!currentCancellation()) { await this.supersededCancellation(entry, api); return; }
        if (entry.report.videoId) await api.unschedule(entry.report.videoId);
      } catch (error) {
        if (!currentCancellation()) { await this.supersededCancellation(entry, api); return; }
        if (entry.report.videoId && error instanceof VideoApiError && ["ALREADY_PUBLIC", "VIDEO_CHANGED"].includes(error.code)) {
          let latest: VideoResource | undefined;
          try { latest = (await api.list([entry.report.videoId]))[0]; }
          catch (readError) { if (!currentCancellation()) { await this.supersededCancellation(entry, api); return; } throw readError; }
          if (!currentCancellation()) { await this.supersededCancellation(entry, api); return; }
          if (latest?.status?.privacyStatus === "public") { await this.alreadyPublic(entry, true); return; }
        }
        throw error;
      }
      if (!currentCancellation()) { await this.supersededCancellation(entry, api); return; }
      await this.update(entry, { state: "cancelled", nextAttemptAt: undefined, message: "任务已取消；本地源文件和 YouTube 视频未删除。" }); return;
    }
    if (!entry.spec.policy.enabled) throw new AppError("PUBLISHING_DISABLED", "管理员尚未开启发布模块。");
    if (entry.spec.profile.privacy === "public" && !entry.spec.policy.publicVerified) throw new AppError("PUBLIC_UNVERIFIED", "当前 API Project 尚未完成自动公开验收。");
    if (entry.report.state === "retry_wait") await this.update(entry, { state: entry.resumeState || (entry.report.videoId ? "processing" : "ready"), nextAttemptAt: undefined });
    entry.resumeState = undefined;
    if (entry.report.state === "scheduled" && entry.report.videoId) return;
    if (entry.spec.contentPackage && !entry.report.videoId && !entry.finalUpload) {
      if (entry.session || entry.finalChunkPossible) throw new AppError("UPLOAD_UNCERTAIN", "最终文件检查点缺失，禁止重新生成和重复上传。");
      await this.update(entry, { state: "preparing_media" });
      const abort = new AbortController(); this.aborters.set(entry.spec.id, abort);
      entry.finalUpload = await preparePackageUpload(publishingRoot(), entry.spec.contentPackage, { signal: abort.signal, live: this.options.live });
      const final = entry.finalUpload;
      entry.sha256 = final.sha256;
      await this.update(entry, { total: final.asset.size, prepared: { version: final.asset.version, size: final.asset.size, sha256: final.sha256 } });
      entry.preparedSequence = entry.report.sequence; await this.save();
      if (entry.spec.desired !== "run" || this.stopped) return;
    }
    if (entry.spec.contentPackage && entry.finalUpload && !entry.session && !entry.report.videoId && (this.options.requirePreparedAcknowledgement ?? !this.options.api)) {
      // 在 Cloud 确认最终文件大小前停在 offset 0；后台 sync 不被此等待阻塞。
      while (!this.stopped && entry.spec.desired === "run" && (entry.acknowledged || 0) < (entry.preparedSequence || entry.report.sequence)) await sleep(50);
      if (this.stopped || entry.spec.desired !== "run") return;
    }
    if (!entry.report.metadata) {
      await this.update(entry, { state: "generating_metadata" });
      const generated = await (this.options.metadata || publishingMetadata)(new Store(config(entry.spec.profile.instanceId).dataDir), entry.spec);
      await this.update(entry, { metadata: generated.copy, metadataSource: generated.source, message: generated.source === "fallback" ? "AI 生成失败，使用已确认的兜底文案。" : undefined });
    }
    if (entry.spec.desired !== "run" || this.stopped) return;
    const metadata = entry.report.metadata;
    if (!metadata) throw new AppError("METADATA", "缺少已持久化的发布文案。");
    if (!entry.report.videoId) {
      await this.update(entry, { state: "uploading" });
      const hashAbort = new AbortController(); this.aborters.set(entry.spec.id, hashAbort);
      const root = config(entry.spec.profile.instanceId).mediaRoot; const checked = entry.spec.contentPackage && entry.finalUpload ? await validatePreparedUpload(publishingRoot(), entry.finalUpload, entry.spec.contentPackage, hashAbort.signal) : await validateAsset(root, entry.spec.asset, entry.sha256 || entry.spec.asset.sha256 || undefined, hashAbort.signal);
      entry.sha256 = checked.sha256; await this.save();
      if (entry.spec.desired !== "run" || this.stopped) return;
      if (entry.session) await this.acceptProbe(entry, await api.probe(entry.session, this.uploadAsset(entry).size), api);
      if (!entry.report.videoId && !entry.session) { entry.session = await api.begin({ ...entry.spec, asset: this.uploadAsset(entry) }, "LiveNest upload " + entry.spec.id); entry.finalChunkPossible = false; await this.save(); }
      while (!entry.report.videoId && !this.stopped && entry.spec.desired === "run") {
        if (entry.report.offset === this.uploadAsset(entry).size) throw new VideoApiError("UPLOAD_RESULT", "YouTube 已接收全部字节但结果尚未确认，稍后探测原会话。", true);
        if (!entry.spec.policy.enabled) throw new AppError("PUBLISHING_DISABLED", "发布策略已关闭，保留检查点等待管理员开启。");
        if (entry.spec.contentPackage) await validatePackage(publishingRoot(), entry.spec.contentPackage);
        await this.checkChannel(entry);
        const file = await stat(checked.file); if (file.size !== this.uploadAsset(entry).size || file.mtimeMs !== this.uploadAsset(entry).mtimeMs) throw new AppError("ASSET_CHANGED", "上传期间素材发生变化，已停止。");
        const end = Math.min(this.uploadAsset(entry).size, entry.report.offset + entry.spec.policy.chunkBytes);
        if (end === this.uploadAsset(entry).size) { entry.finalChunkPossible = true; await this.save(); }
        const abort = new AbortController(); this.aborters.set(entry.spec.id, abort);
        const result = await api.chunk(entry.session!, checked.file, entry.report.offset, this.uploadAsset(entry).size, entry.spec.policy.chunkBytes, this.options.live?.() ? entry.spec.policy.liveUploadMbps / entry.spec.policy.concurrency : entry.spec.policy.uploadMbps / entry.spec.policy.concurrency, abort.signal);
        const previous = entry.report.offset; await this.acceptProbe(entry, result, api);
        if (result.expired && !entry.report.videoId) throw new VideoApiError("UPLOAD_EXPIRED", "上传会话已过期，下次从新会话恢复；末块未发送。", true);
        if (!entry.report.videoId && entry.report.offset <= previous) throw new VideoApiError("UPLOAD_STALLED", "YouTube 上传进度未前进，稍后先探测再续传。", true);
      }
      if (entry.spec.desired !== "run" || this.stopped) return;
      await this.update(entry, { state: "processing", nextAttemptAt: this.now() }); return;
    }
    if (entry.report.state === "processing") return;
    const finalizingRevision = entry.spec.revision; const finalizingSpec = entry.spec;
    await this.update(entry, { state: "finalizing" });
    if (!this.currentFinalization(entry, finalizingRevision)) return;
    if (entry.spec.contentPackage) await validatePackage(publishingRoot(), entry.spec.contentPackage);
    if (entry.spec.profile.thumbnailMode !== "none" && !entry.thumbnailDone) {
      const filename = entry.spec.profile.thumbnailMode === "fixed" ? entry.spec.profile.thumbnailFilename : entry.spec.asset.thumbnail;
      if (entry.spec.contentPackage && entry.spec.profile.thumbnailMode === "matching") {
        if (entry.spec.contentPackage.cover) { await validatePackage(publishingRoot(), entry.spec.contentPackage); await api.thumbnail(entry.report.videoId, await resolvePackageFile(publishingRoot(), entry.spec.contentPackage, entry.spec.contentPackage.cover, "cover")); }
      } else {
        if (!filename) throw new AppError("THUMBNAIL", "缺少提前准备的缩略图，请补充同名图片后重新确认素材。");
        await api.thumbnail(entry.report.videoId, await resolvePublishingThumbnail(config(entry.spec.profile.instanceId).mediaRoot, filename));
      }
      entry.thumbnailDone = true; await this.save();
    }
    for (const id of entry.spec.profile.playlistIds) if (!entry.playlistsDone.includes(id)) { if (entry.spec.desired !== "run" || this.stopped) return; await api.playlist(entry.report.videoId, id); entry.playlistsDone.push(id); await this.save(); }
    if (!this.currentFinalization(entry, finalizingRevision)) return;
    const current = (await api.list([entry.report.videoId]))[0];
    if (!this.currentFinalization(entry, finalizingRevision)) return;
    if (!current) throw new VideoApiError("VIDEO_MISSING", "定时公开前无法核对视频。");
    if (current.status?.privacyStatus === "public") { await this.alreadyPublic(entry); return; }
    // 更新响应丢失时，先比对完整元数据和排期，避免将已成功排期再次向后推迟。
    const scheduleMatches = !entry.spec.profile.scheduled || !entry.scheduleRevisionPending && sameMoment(current.status?.publishAt, entry.report.effectivePublishAt);
    const metadataMatches = current.snippet?.title === metadata.title && current.snippet?.description === metadata.description && current.snippet?.categoryId === entry.spec.profile.categoryId && JSON.stringify(current.snippet?.tags || []) === JSON.stringify(entry.spec.profile.tags) && current.status?.selfDeclaredMadeForKids === entry.spec.profile.madeForKids && current.status?.license === entry.spec.profile.license && current.status?.embeddable === entry.spec.profile.embeddable && current.status?.containsSyntheticMedia === entry.spec.profile.containsSyntheticMedia;
    if (!entry.finalized && !(scheduleMatches && metadataMatches && current.status?.privacyStatus === (entry.spec.profile.scheduled ? "private" : entry.spec.profile.privacy))) {
      const publishAt = finalizingSpec.profile.scheduled ? effectivePublishAt(finalizingSpec.originalPublishAt!, finalizingSpec.policy.publishLeadSeconds, this.now()) : undefined;
      entry.scheduleRevisionPending = false;
      await this.update(entry, { effectivePublishAt: publishAt });
      if (!this.currentFinalization(entry, finalizingRevision)) return;
      try { await api.finalize(entry.report.videoId, finalizingSpec, metadata, publishAt); }
      catch (error) {
        if (!this.currentFinalization(entry, finalizingRevision)) return;
        if (error instanceof VideoApiError && ["ALREADY_PUBLIC", "VIDEO_CHANGED"].includes(error.code)) {
          const latest = (await api.list([entry.report.videoId]))[0];
          if (!this.currentFinalization(entry, finalizingRevision)) return;
          if (latest?.status?.privacyStatus === "public") { await this.alreadyPublic(entry); return; }
        }
        throw error;
      }
      if (!this.currentFinalization(entry, finalizingRevision)) return;
    }
    const after = (await api.list([entry.report.videoId]))[0];
    if (!this.currentFinalization(entry, finalizingRevision)) return;
    if (!after) throw new VideoApiError("VIDEO_MISSING", "更新结果无法核对。", true);
    if (entry.spec.profile.scheduled && after.status?.privacyStatus !== "public" && (!sameMoment(after.status?.publishAt, entry.report.effectivePublishAt) || after.status?.privacyStatus !== "private")) { entry.finalized = false; await this.save(); if (!this.currentFinalization(entry, finalizingRevision)) return; throw new VideoApiError("SCHEDULE_UNCONFIRMED", "YouTube 排期未确认，请核对 API Audit 和频道设置。"); }
    if (!entry.spec.profile.scheduled && after.status?.privacyStatus !== entry.spec.profile.privacy) { entry.finalized = false; await this.save(); if (!this.currentFinalization(entry, finalizingRevision)) return; throw new VideoApiError("PRIVACY_UNCONFIRMED", "YouTube 可见性未确认，请核对项目审核状态。"); }
    // 回读确认后才固定完成标记；旧检查点的错误标记也在上面的不一致分支清除。
    entry.finalized = true;
    entry.reschedulePreviousAt = undefined;
    await this.update(entry, { state: after.status?.privacyStatus === "public" ? "published" : entry.spec.profile.scheduled ? "scheduled" : "completed", observedPrivacy: after.status?.privacyStatus, remoteCheckedAt: this.now(), nextAttemptAt: this.now() + entry.spec.policy.scheduledPollSeconds * 1000, message: undefined });
  }
  /** session 失效只有确认末块未发送时可重建；否则必须精确匹配唯一视频。 */
  private async acceptProbe(entry: Entry, probe: { offset: number; videoId?: string; expired?: boolean }, api: VideoPort) {
    if (probe.expired) {
      if (entry.finalChunkPossible) { const matches = await api.recover("LiveNest upload " + entry.spec.id, entry.spec.profile.channelId); if (matches.length !== 1) throw new AppError("UPLOAD_UNCERTAIN", "上传结果未知，未创建第二个视频。请在 YouTube Studio 人工核对。"); await this.update(entry, { videoId: matches[0], offset: this.uploadAsset(entry).size }); }
      else { entry.session = undefined; await this.update(entry, { offset: 0 }); }
      return;
    }
    await this.update(entry, { offset: probe.offset, ...(probe.videoId ? { videoId: probe.videoId } : {}) });
  }
  /** 同一实例/频道合并查询，不为每个任务建立独立轮询定时器。 */
  private async poll(entries: Entry[]) {
    const groups = new Map<string, Entry[]>();
    for (const e of entries) if (!this.purging.has(this.authorizationKey(e.spec)) && !this.active.has(e.spec.id) && e.spec.desired === "run" && e.report.videoId && ["processing", "scheduled", "published", "completed"].includes(e.report.state) && (e.report.nextAttemptAt || 0) <= this.now()) { const key = e.spec.profile.agentId + ":" + e.spec.profile.instanceId + ":" + (e.spec.profile.accountId || "legacy") + ":" + e.spec.profile.channelId; groups.set(key, [...(groups.get(key) || []), e]); }
    for (const group of groups.values()) for (let start = 0; start < group.length; start += group[0].spec.policy.pollBatchSize) {
      const batch = group.slice(start, start + group[0].spec.policy.pollBatchSize);
      try { await this.checkChannel(batch[0]); const results = await this.api(batch[0]).list(batch.map(e => e.report.videoId!)); for (const e of batch) await this.observe(e, results.find(v => v.id === e.report.videoId)); }
      catch (error) { for (const e of batch) await this.failure(e, error); }
    }
  }
  /** 只有远端公开才标记 published；缺失结果保留任务，禁止猜测删除。 */
  private async observe(entry: Entry, video?: VideoResource) {
    const interval = entry.report.state === "processing" ? entry.spec.policy.processingPollSeconds : entry.report.state === "scheduled" && entry.report.effectivePublishAt && Date.parse(entry.report.effectivePublishAt) < this.now() + 3_600_000 ? entry.spec.policy.processingPollSeconds : publishingTerminal(entry.report.state) ? 25 * 86400 : entry.spec.policy.scheduledPollSeconds;
    if (!video) { await this.update(entry, { message: "视频状态暂时无法核对，没有认定删除或失败。", nextAttemptAt: this.now() + interval * 1000 }); return; }
    if (video.snippet?.channelId && video.snippet.channelId !== entry.spec.profile.channelId) throw new AppError("CHANNEL", "查询结果来自其他频道。");
    const processingStatus = video.processingDetails?.processingStatus;
    let state = entry.report.state;
    if (video.status?.privacyStatus === "public") state = "published";
    else if (["failed", "terminated"].includes(processingStatus || "") || ["failed", "rejected"].includes(video.status?.uploadStatus || "")) state = "failed";
    else if (state === "processing" && (processingStatus === "succeeded" || video.status?.uploadStatus === "processed")) state = "finalizing";
    else if (state === "scheduled" && (video.status?.privacyStatus !== "private" || !sameMoment(video.status.publishAt, entry.report.effectivePublishAt))) state = "needs_attention";
    await this.update(entry, { state, processingStatus, observedPrivacy: video.status?.privacyStatus, remoteCheckedAt: this.now(), nextAttemptAt: state === "finalizing" ? this.now() : this.now() + interval * 1000, message: state === "needs_attention" ? "YouTube 排期已被修改，未自动覆盖人工操作。" : undefined });
  }
  /** 上传会话始终绑定准备完成的不可变文件，旧扁平素材任务继续使用原 asset。 */
  private uploadAsset(entry: Entry) { return entry.finalUpload?.asset || entry.spec.asset; }
  /** 本机再次检查所有引用后归档；活动上传和新任务不能与搬移并行。 */
  async archiveBatch(batch: PackageBatch, archiveId: string) {
    await this.accepting; await this.load();
    if (this.archives.has(batch.name)) throw new AppError("ARCHIVE_BUSY", "该批次正在归档。");
    const references = [...this.entries.values()].filter(e => e.spec.contentPackage?.batchName === batch.name);
    /** 只有当前修订被明确取消的历史任务才不再阻塞整批归档。 */
    const safelyCancelled = (e: Entry) => e.spec.desired === "cancel" && e.report.state === "cancelled" && e.report.revision === e.spec.revision;
    /** published 是真实公开后的持久结果，不随 API 观察字段到期删除而失效。 */
    const complete = (e: Entry) => e.report.revision === e.spec.revision && (e.report.state === "published" || e.report.state === "completed" && (e.spec.profile.privacy !== "public" || e.report.observedPrivacy === "public"));
    if (references.some(e => this.active.has(e.spec.id) || !safelyCancelled(e) && !complete(e)) || batch.packages.some(pkg => !references.some(e => e.spec.contentPackage?.id === pkg.id && e.spec.contentPackage.version === pkg.version && complete(e)))) throw new AppError("ARCHIVE_BUSY", "批次仍有未完成任务或内容版本没有完成记录，不能移动源文件。");
    const promise = archivePublishingBatch(publishingRoot(), batch, archiveId);
    this.archives.set(batch.name, promise);
    try { return await promise; } finally { this.archives.delete(batch.name); }
  }
  /** 维护仅阻止当前执行，不让未来排期永久阻塞升级。 */
  get busy() { return this.active.size > 0 || this.archives.size > 0; }
  /** 停止时中断当前 HTTP 并保存检查点，不等待数小时视频传完。 */
  async stop() { this.stopped = true; for (const abort of this.aborters.values()) abort.abort(); await Promise.allSettled([...this.active.values(), ...this.archives.values()]); await this.writes; }
  /** 撤销或删除授权前停止该实例任务并清除本地 API 数据；源素材保留。 */
  async purge(instanceId: string, accountId?: string) { const key = accountId ? "account:" + accountId : "legacy:" + instanceId; this.purging.add(key); try { await this.accepting; await this.load(); const active: Promise<void>[] = []; for (const e of this.entries.values()) if (e.spec.profile.instanceId === instanceId && e.spec.profile.accountId === accountId) { e.spec.desired = "pause"; this.aborters.get(e.spec.id)?.abort(); const task = this.active.get(e.spec.id); if (task) active.push(task); } await Promise.allSettled(active); for (const [id, e] of this.entries) if (e.spec.profile.instanceId === instanceId && e.spec.profile.accountId === accountId) this.entries.delete(id); await this.save(); } finally { this.purging.delete(key); } }
}
