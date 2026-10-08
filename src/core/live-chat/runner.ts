/** 每实例常驻直播陪聊：接收和生成独立执行，持久游标恢复，未知发送绝不重放。 */
import type { LiveChatBatch, LiveChatConfig, LiveChatEntry, LiveChatMessage, LiveChatPorts, LiveChatStatus, LiveChatTarget } from "@/shared/live-chat";
import { liveChatConfigSchema } from "@/shared/live-chat";
import { Store } from "../storage";
import { AppError } from "../errors";
import { readCheckpoint, writeCheckpoint, type Checkpoint, messageSchema, checkpointSchema } from "./checkpoint";
import { chatErrorCode, errorMessages, MAX_AGE_MS, nextQuotaMidnight, spamKey } from "./policy";

export class LiveChatRunner {
  private checkpoint!: Checkpoint;
  private loading?: Promise<void>;
  private initializationFailed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private requested = false;
  private lifetime?: AbortController;
  private loops?: Promise<unknown>;
  private startup?: Promise<void>;
  private streamTask?: Promise<void>;
  private streamAbort?: AbortController;
  private streamConnected = false;
  private actionAbort?: AbortController;
  private epoch = 0;
  private configured = false;
  private target?: LiveChatTarget;
  private failures = 0;
  private view: Pick<LiveChatStatus, "state" | "message" | "nextRetryAt" | "updatedAt"> = { state: "connecting", message: "正在读取聊天配置。", updatedAt: 0 };
  /** 注入只含聊天能力的端口；构造不会联网，也不会启动直播。 */
  constructor(private store: Store, private ports: LiveChatPorts) {}
  /** 使用注入时钟驱动消息年龄、限频和配额恢复，便于确定性故障验证。 */
  private now() { return this.ports.now?.() ?? Date.now(); }
  /** 读取一次检查点；前进程留下 sending 时只记未知结果，不放回队列。 */
  private initialize() {
    if (!this.loading) this.loading = (async () => { try {
      this.checkpoint = await readCheckpoint(this.store, this.now());
      const recovering = !!this.checkpoint.sending;
      if (this.checkpoint.sending) {
        const sending = this.checkpoint.sending;
        this.record(sending.message, "uncertain", errorMessages.CHAT_UNCERTAIN, sending.reply);
        this.checkpoint.sending = undefined;
      }
      this.expire();
      // 空默认状态不可要求尚未配置的加密密钥；真实恢复记录才需要重新落盘。
      if (recovering) await writeCheckpoint(this.store, this.checkpoint);
      this.configured = await this.ports.configured();
      this.setView(this.checkpoint.config.enabled ? this.configured ? "waiting_live" : "needs_key" : "disabled");
    } catch {
      // 无法确认旧记录时只提供禁用的公开兜底，保留原文件并拒绝所有写入。
      this.initializationFailed = true;
      this.checkpoint ||= checkpointSchema.parse({ config: { enabled: false }, enabledAt: this.now(), sessionAt: this.now(), seen: [], spam: [], queue: [], recent: [], sent: 0, skipped: 0, lastAttemptAt: 0 });
      this.storageFailure();
    } })();
    return this.loading;
  }
  /** 所有检查点变更串行且等待原子写入，不让异步流覆盖配置或发送结果。 */
  private mutate(fn: () => void | Promise<void>) {
    const next = this.writes.then(async () => {
      await this.initialize(); if (this.initializationFailed) throw new AppError("CHAT_STORAGE", errorMessages.CHAT_STORAGE, 409);
      const previous = structuredClone(this.checkpoint);
      try { await fn(); await writeCheckpoint(this.store, this.checkpoint); }
      catch {
        // 保存失败时恢复最后已持久化值，立即停网；不能把内存草稿当作成功配置。
        this.checkpoint = previous; this.storageFailure(); throw new AppError("CHAT_STORAGE", errorMessages.CHAT_STORAGE, 409);
      }
    });
    this.writes = next.catch(() => {});
    return next;
  }
  /** 启动两个后台循环并立即返回；错误只转换成固定状态。 */
  start(): void {
    this.requested = true;
    if (this.initializationFailed) { this.storageFailure(); return; }
    if (!this.stopped || this.startup) return;
    const previous = this.loops; const stream = this.streamTask;
    const launch = (async () => {
      // 故障恢复必须先排空旧消费者，不能让旧等待回调在新 lifetime 中继续消费。
      await Promise.allSettled([previous, stream]); if (!this.requested) return;
      this.stopped = false; this.lifetime = new AbortController();
      this.loops = Promise.allSettled([this.monitor().catch(() => this.storageFailure()), this.deliver().catch(() => this.storageFailure())]);
    })();
    const startup = launch.finally(() => { if (this.startup === startup) this.startup = undefined; });
    this.startup = startup;
    void startup.catch(() => this.storageFailure());
  }
  /** 退出立即取消读取、生成和发送，并等待发送意图的最终落盘。 */
  async stop(): Promise<void> {
    this.requested = false; this.stopped = true; this.lifetime?.abort(); this.cancel();
    await this.startup;
    await Promise.allSettled([this.loops, this.streamTask]); await this.writes;
    if (this.checkpoint?.queue.length && !this.initializationFailed) await this.mutate(() => this.clearQueue("运行进程已退出，待回复消息已跳过。"));
  }
  /** 返回公开且独立复制的快照，密钥和内部游标永不进入浏览器。 */
  async status(): Promise<LiveChatStatus> {
    await this.initialize(); await this.writes;
    return structuredClone({ ...this.view, config: this.checkpoint.config, configured: this.configured, sent: this.checkpoint.sent, skipped: this.checkpoint.skipped, queued: this.checkpoint.queue.length, recent: this.checkpoint.recent });
  }
  /** 设置独立于开停播锁；任何显式修改先取消旧生成，重新启用从当前时刻收取新消息。 */
  async configure(config: LiveChatConfig): Promise<LiveChatStatus> {
    const parsed = liveChatConfigSchema.safeParse(config);
    if (!parsed.success) throw new AppError("INPUT", "请检查互动风格、提示词和 5–60 秒回复间隔。");
    this.cancel(); await this.initialize();
    await this.mutate(() => {
      const enabling = !this.checkpoint.config.enabled && parsed.data.enabled;
      this.clearQueue("互动设置已修改，旧待回复消息已跳过。");
      this.checkpoint.config = parsed.data;
      if (enabling) { this.checkpoint.enabledAt = this.now(); this.checkpoint.sessionAt = this.now(); this.checkpoint.pageToken = undefined; }
      if (this.checkpoint.block?.code !== "CHAT_QUOTA" && this.checkpoint.block?.code !== "CHAT_UNAVAILABLE") this.checkpoint.block = undefined;
    });
    this.failures = 0; this.setView(parsed.data.enabled ? this.configured ? "waiting_live" : "needs_key" : "disabled");
    if (this.requested && this.stopped) this.start();
    return this.status();
  }
  /** 重新授权等服务配置变化后解除永久阻断，丢弃旧待回复并重新验证当前场次；方法名保留兼容。 */
  async keyChanged(): Promise<void> {
    this.cancel(); await this.initialize();
    await this.mutate(() => {
      this.clearQueue("授权配置已更新，旧待回复消息已跳过。");
      if (this.checkpoint.block?.code !== "CHAT_QUOTA" && this.checkpoint.block?.code !== "CHAT_UNAVAILABLE") this.checkpoint.block = undefined;
      this.checkpoint.enabledAt = this.now(); this.checkpoint.sessionAt = this.now(); this.checkpoint.pageToken = undefined;
    });
    this.configured = await this.ports.configured(); this.failures = 0;
    if (this.requested && this.stopped) this.start();
  }
  /** 存储失败停止所有网络工作；已初始化的公开状态仍可读取，显式配置成功后才恢复。 */
  private storageFailure() { this.stopped = true; this.lifetime?.abort(); this.cancel(); this.setView("needs_attention", errorMessages.CHAT_STORAGE); }
  /** 取消旧工作并增加代数，忽略不遵守 AbortSignal 的迟到生成结果。 */
  private cancel() { this.epoch++; this.streamAbort?.abort(); this.actionAbort?.abort(); }
  /** 统一有界公开文案；观察状态与直播控制状态各自独立。 */
  private setView(state: LiveChatStatus["state"], message?: string, nextRetryAt?: number) {
    const messages: Record<LiveChatStatus["state"], string> = { disabled: "AI 互动已关闭。", needs_key: "AI互动等待直播电脑的DeepSeek环境配置，请联系管理员", waiting_live: "AI 互动已开启，等待直播。", connecting: "正在连接当前直播聊天。", running: "正在与观众互动。", reconnecting: "聊天连接暂时中断，正在等待重连。", needs_attention: "AI 互动需要处理。", unavailable: errorMessages.CHAT_UNAVAILABLE, quota_wait: errorMessages.CHAT_QUOTA };
    this.view = { state, message: message || messages[state], ...(nextRetryAt ? { nextRetryAt } : {}), updatedAt: this.now() };
  }
  /** 更新最近 30 条真实结果；同一消息的 queued 到 sent 不重复占用历史条目。 */
  private record(message: LiveChatMessage, status: LiveChatEntry["status"], reason?: string, reply?: string) {
    const entry: LiveChatEntry = { id: message.id, authorId: message.authorId, author: message.author, text: message.text, status, at: this.now(), ...(reason ? { reason } : {}), ...(reply ? { reply } : {}) };
    const index = this.checkpoint.recent.findIndex(item => item.id === message.id);
    if (index >= 0) this.checkpoint.recent.splice(index, 1);
    this.checkpoint.recent.push(entry); this.checkpoint.recent = this.checkpoint.recent.slice(-30);
    if (status === "skipped") this.checkpoint.skipped++;
    if (status === "sent") this.checkpoint.sent++;
  }
  /** 停用或换场清理待回复，保留历史发送事实和未知发送检查点。 */
  private clearQueue(reason: string) { for (const message of this.checkpoint.queue) this.record(message, "skipped", reason); this.checkpoint.queue = []; }
  /** 队列和刷屏指纹最多有效两分钟；过期消息记录跳过且不再生成。 */
  private expire() {
    const cutoff = this.now() - MAX_AGE_MS;
    const expired = this.checkpoint.queue.filter(message => message.publishedAt < cutoff);
    for (const message of expired) this.record(message, "skipped", "消息已超过两分钟，已跳过。");
    this.checkpoint.queue = this.checkpoint.queue.filter(message => message.publishedAt >= cutoff);
    this.checkpoint.seen = this.checkpoint.seen.filter(item => item.at >= cutoff).slice(-10000);
    this.checkpoint.spam = this.checkpoint.spam.filter(item => item.at >= cutoff).slice(-10000);
  }
  /** 等待可被退出打断的短间隔；不依赖浏览器连接。 */
  private pause(ms = 500) {
    const signal = this.lifetime?.signal;
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms); signal?.addEventListener("abort", finish, { once: true });
    });
  }
  /** 观察场次变化并独立管理流；浏览器关闭或 cloud 掉线不停止本机互动。 */
  private async monitor() {
    await this.initialize();
    while (!this.stopped) {
      try { await this.inspect(); }
      catch (error) { await this.fail(error); }
      await this.pause();
    }
  }
  /** 检查配置和真实场次；所有停止条件先取消生成，再清队列。 */
  private async inspect() {
    this.configured = await this.ports.configured();
    if (!this.checkpoint.config.enabled || !this.configured) {
      if (this.streamAbort && !this.streamAbort.signal.aborted || this.checkpoint.queue.length) { this.cancel(); await this.mutate(() => this.clearQueue("互动暂未运行，已跳过待回复消息。")); }
      this.setView(this.checkpoint.config.enabled ? "needs_key" : "disabled"); return;
    }
    const paused = this.checkpoint.block;
    if (paused && paused.code !== "CHAT_UNAVAILABLE" && (paused.until === undefined || paused.until > this.now())) {
      this.setView(paused.code === "CHAT_QUOTA" ? "quota_wait" : paused.until ? "reconnecting" : "needs_attention", errorMessages[paused.code] || errorMessages.CHAT_NETWORK, paused.until); return;
    }
    const target = await this.ports.observe(); this.target = target;
    const identity = target.channelId && target.broadcastId ? JSON.stringify([target.channelId, target.broadcastId, target.liveChatId || ""]) : undefined;
    if (identity !== this.checkpoint.target) {
      this.cancel(); await this.mutate(() => {
        this.clearQueue("直播场次已变化，旧消息已跳过。");
        this.checkpoint.target = identity; this.checkpoint.chatId = target.liveChatId; this.checkpoint.pageToken = undefined; this.checkpoint.seen = []; this.checkpoint.seenAuthors = []; this.checkpoint.spam = []; this.checkpoint.sessionAt = this.now();
        if (this.checkpoint.block?.code === "CHAT_UNAVAILABLE") this.checkpoint.block = undefined;
      }); this.failures = 0;
    }
    if (!target.live || !target.liveChatId || !target.channelId || !target.broadcastId || target.available === false) {
      if (this.streamAbort && !this.streamAbort.signal.aborted || this.checkpoint.queue.length) { this.cancel(); await this.mutate(() => this.clearQueue("当前场次未在直播，待回复消息已跳过。")); }
      this.setView(target.live && target.available === false ? "unavailable" : "waiting_live"); return;
    }
    if (this.checkpoint.queue.some(message => message.publishedAt < this.now() - MAX_AGE_MS)) await this.mutate(() => this.expire());
    const block = this.checkpoint.block;
    if (block && block.until !== undefined && block.until <= this.now()) await this.mutate(() => { this.checkpoint.block = undefined; });
    else if (block) {
      this.setView(block.code === "CHAT_QUOTA" ? "quota_wait" : block.code === "CHAT_UNAVAILABLE" ? "unavailable" : block.until ? "reconnecting" : "needs_attention", errorMessages[block.code] || errorMessages.CHAT_NETWORK, block.until); return;
    }
    if (!this.streamTask) {
      this.setView("connecting"); this.streamConnected = false; const epoch = this.epoch; const abort = new AbortController(); this.streamAbort = abort;
      this.streamTask = this.readStream(target.liveChatId, epoch, abort).catch(() => this.storageFailure()).finally(() => { this.streamTask = undefined; });
    }
    if (this.streamAbort && !this.streamAbort.signal.aborted) this.setView(this.streamConnected ? "running" : "connecting");
  }
  /** 接收批次与游标同时落盘；正常流结束仍从最后游标退避重连。 */
  private async readStream(chatId: string, epoch: number, abort: AbortController) {
    try {
      for await (const batch of this.ports.stream(chatId, this.checkpoint.pageToken, abort.signal)) {
        if (epoch !== this.epoch || abort.signal.aborted || this.stopped) return;
        await this.receive(batch, epoch); this.failures = 0; this.streamConnected = true; this.setView("running");
        if (batch.offlineAt) { await this.fail(new AppError("CHAT_UNAVAILABLE", errorMessages.CHAT_UNAVAILABLE)); return; }
      }
      if (!abort.signal.aborted && epoch === this.epoch) await this.fail(new AppError("CHAT_NETWORK", errorMessages.CHAT_NETWORK));
    } catch (error) { if (!abort.signal.aborted && epoch === this.epoch) await this.fail(error); }
  }
  /** 过滤历史、自身、非文字和同文刷屏；有限队列拥堵时明确跳过新增消息。 */
  private async receive(batch: LiveChatBatch, epoch: number) {
    await this.mutate(() => {
      if (epoch !== this.epoch || !this.checkpoint.config.enabled) return;
      this.expire();
      for (const raw of batch.messages) {
        const parsed = messageSchema.safeParse(raw); if (!parsed.success) continue;
        const message = parsed.data;
        if (this.checkpoint.seen.some(item => item.id === message.id)) continue;
        this.checkpoint.seen.push({ id: message.id, at: this.now() });
        if (message.type !== "textMessageEvent" || message.authorId === this.target?.channelId || !message.text.trim()) continue;
        if (message.publishedAt < Math.max(this.checkpoint.enabledAt, this.checkpoint.sessionAt) || message.publishedAt < this.now() - MAX_AGE_MS) { this.record(message, "skipped", "消息早于本次启用时间或已过期。"); continue; }
        const key = spamKey(message);
        if (this.checkpoint.spam.some(item => item.key === key)) { this.record(message, "skipped", "重复刷屏消息已跳过。"); continue; }
        this.checkpoint.spam.push({ key, at: this.now() });
        message.firstMessage = !!message.authorId && !this.checkpoint.seenAuthors.includes(message.authorId) && this.checkpoint.seenAuthors.length < 10000;
        if (message.firstMessage) this.checkpoint.seenAuthors.push(message.authorId);
        if (this.checkpoint.queue.length >= 100) this.record(this.checkpoint.queue.shift()!, "skipped", "队列已达到 100 条，已跳过最早的待回复消息。");
        this.checkpoint.queue.push(message); this.record(message, "queued");
      }
      this.checkpoint.seen = this.checkpoint.seen.slice(-10000); this.checkpoint.spam = this.checkpoint.spam.slice(-10000);
      if (batch.nextPageToken) this.checkpoint.pageToken = batch.nextPageToken;
    });
  }
  /** 串行生成与发送，按实例限制频率而不设每日条数上限。 */
  private async deliver() {
    await this.initialize();
    while (!this.stopped) {
      const checkpoint = this.checkpoint;
      if (checkpoint.config.enabled && this.configured && !checkpoint.block && this.target?.live && checkpoint.queue.length && this.now() >= checkpoint.lastAttemptAt + checkpoint.config.intervalSeconds * 1000) await this.deliverOne(checkpoint.queue[0]);
      await this.pause(100);
    }
  }
  /** 发送前重读场次并检查取消代数；落盘 sending 后才调用不可回滚的外部发送。 */
  private async deliverOne(message: LiveChatMessage) {
    const epoch = this.epoch; const abort = new AbortController(); this.actionAbort = abort; let attempted = false;
    try {
      const context = this.checkpoint.recent.filter(entry => entry.authorId === message.authorId && entry.status === "sent" && entry.at >= this.checkpoint.sessionAt && this.checkpoint.receipts.some(receipt => receipt.messageId === entry.id && receipt.target === this.checkpoint.target)).slice(-5);
      const content = await this.ports.generate(structuredClone(this.checkpoint.config), message, structuredClone(context), abort.signal);
      if (epoch !== this.epoch || abort.signal.aborted || this.stopped) return;
      const target = await this.ports.observe();
      const identity = JSON.stringify([target.channelId, target.broadcastId, target.liveChatId || ""]);
      if (!target.live || target.available === false || identity !== this.checkpoint.target || message.publishedAt < this.now() - MAX_AGE_MS) { this.cancel(); await this.mutate(() => this.clearQueue("场次已结束或消息已过期，已跳过待回复。")); return; }
      const reply = content.trim();
      if (!reply || reply.length > 200 || !reply.startsWith("[AI]")) throw new AppError("AI_OUTPUT", errorMessages.AI_OUTPUT);
      await this.mutate(() => {
        if (epoch !== this.epoch || !this.checkpoint.config.enabled || !this.checkpoint.queue.some(item => item.id === message.id)) return;
        this.checkpoint.sending = { message, reply, at: this.now() }; this.checkpoint.lastAttemptAt = this.now();
        this.checkpoint.queue = this.checkpoint.queue.filter(item => item.id !== message.id);
      });
      if (epoch !== this.epoch || abort.signal.aborted || !this.checkpoint.config.enabled || this.checkpoint.sending?.message.id !== message.id) return;
      attempted = true; const result = await this.ports.send(target.liveChatId!, reply, abort.signal);
      if (!result.id || result.id.length > 200) throw new AppError("CHAT_UNCERTAIN", errorMessages.CHAT_UNCERTAIN, 502);
      await this.mutate(() => {
        this.record(message, "sent", undefined, reply);
        this.checkpoint.receipts.push({ messageId: message.id, sentMessageId: result.id, at: this.now(), target: identity }); this.checkpoint.receipts = this.checkpoint.receipts.slice(-30);
        if (this.checkpoint.sending?.message.id === message.id) this.checkpoint.sending = undefined;
      });
    } catch (error) {
      if (!attempted && (abort.signal.aborted || epoch !== this.epoch)) return;
      const code = chatErrorCode(error, attempted);
      if (code === "CHAT_STORAGE") { this.storageFailure(); return; }
      await this.mutate(() => {
        this.checkpoint.queue = this.checkpoint.queue.filter(item => item.id !== message.id);
        const unknown = attempted && (code === "CHAT_UNCERTAIN" || abort.signal.aborted);
        this.record(message, unknown ? "uncertain" : code === "AI_OUTPUT" ? "skipped" : "failed", errorMessages[unknown ? "CHAT_UNCERTAIN" : code] || errorMessages.CHAT_NETWORK, this.checkpoint.sending?.reply);
        if (this.checkpoint.sending?.message.id === message.id) this.checkpoint.sending = undefined;
      });
      if (!abort.signal.aborted && epoch === this.epoch && code !== "AI_OUTPUT") await this.fail(error, attempted);
    } finally {
      if (!attempted && this.checkpoint.sending?.message.id === message.id) await this.mutate(() => { this.record(message, "skipped", "发送前已取消，未发送此条回复。"); this.checkpoint.sending = undefined; });
      if (this.actionAbort === abort) this.actionAbort = undefined;
    }
  }
  /** 保存固定错误策略；配置错误等待人工操作，配额按太平洋午夜恢复。 */
  private async fail(error: unknown, sending = false) {
    const code = chatErrorCode(error, sending); this.cancel(); this.failures++;
    await this.mutate(() => {
      const permanent = ["AI_CONFIG", "AI_BALANCE", "YOUTUBE_AUTH", "CHAT_STORAGE", "CHAT_UNAVAILABLE"].includes(code);
      this.checkpoint.block = { code, ...(code === "CHAT_QUOTA" ? { until: nextQuotaMidnight(this.now()) } : permanent ? {} : { until: this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)) }), ...(code === "CHAT_UNAVAILABLE" ? { target: this.checkpoint.target } : {}) };
      if (permanent || code === "CHAT_QUOTA") this.clearQueue("互动暂时停止，待回复消息已跳过。");
    });
    const block = this.checkpoint.block!;
    this.setView(code === "CHAT_QUOTA" ? "quota_wait" : code === "CHAT_UNAVAILABLE" ? "unavailable" : block.until ? "reconnecting" : "needs_attention", errorMessages[code] || errorMessages.CHAT_NETWORK, block.until);
  }
}
