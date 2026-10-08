/** 按实例缓存独立控制服务；一个实例的长操作不阻塞其他实例。 */
import path from "node:path";
import { claimHost } from "./ownership";
import { Commands } from "./commands";
import type { Dashboard } from "@/shared/types";
import { Control } from "./control";
import { config, missingConfig, requireInstance, validateInstances } from "./config";
import { Store } from "./storage";
import { resolveMedia, scanMedia } from "./media";
import { safeError, problemFor } from "./errors";
import { LocalObsRuntime } from "./obs/runtime";
import { YouTubeAuth } from "./youtube/auth";
import { YouTubeApi } from "./youtube/api";
import { ObsController } from "./obs/controller";
import { ObsProcessManager } from "./obs/process";
import { saveChannelBinding } from "./youtube/bindings";
import { LiveChatRunner } from "./live-chat/runner";
import { YouTubeLiveChat } from "./youtube/live-chat";
import { generateLiveChatReply, liveChatAiConfigured } from "./live-chat-ai";
import type { Broadcast } from "./youtube/api";
import type { LiveChatTarget } from "@/shared/live-chat";
export class Service {
  readonly auth: YouTubeAuth;
  readonly youtube: YouTubeApi;
  readonly obs: LocalObsRuntime;
  readonly control: Control;
  readonly commands: Commands;
  readonly chat: LiveChatRunner;
  /** 所有有状态依赖按实例创建；main 继续读取原来的 .data。 */
  constructor(readonly id: string, saveBinding = saveChannelBinding) {
    /** 始终读取构造时选定实例的配置。 */
    const readConfig = () => config(id);
    const storage = new Store(readConfig().dataDir);
    this.auth = new YouTubeAuth(storage, id, tokens => saveBinding(id, tokens));
    this.youtube = new YouTubeApi(this.auth, storage);
    this.obs = new LocalObsRuntime(new ObsController(readConfig, { id, scene: "LIVE", video: "VIDEO", music: "MUSIC" }), new ObsProcessManager(readConfig));
    this.control = new Control(this.obs, this.youtube, storage, async selection => ({
      video: await resolveMedia(readConfig().mediaRoot, "videos", selection.video),
      music: await resolveMedia(readConfig().mediaRoot, "music", selection.music),
    }));
    this.commands = new Commands(new Store(path.join(storage.dir, "commands")), this.control, id, () => this.invalidate());
    const chatApi = new YouTubeLiveChat(this.auth);
    this.chat = new LiveChatRunner(storage, {
      observe: () => this.observeChat(),
      configured: async () => liveChatAiConfigured(),
      stream: (chatId, pageToken, signal) => chatApi.stream(chatId, pageToken, signal),
      send: (chatId, text, signal) => chatApi.send(chatId, text, signal),
      generate: (settings, message, context, signal) => generateLiveChatReply(storage, settings, message, context, signal),
    });
  }
  private broadcastCache?: { key: string; at: number; value: Broadcast | null };
  private broadcastReading?: { key: string; generation: number; value: Promise<Broadcast | null> };
  private broadcastGeneration = 0;
  private ytCache?: { key: string; at: number; value: Dashboard["youtube"] };
  private reading?: Promise<Dashboard>;
  /** 控制操作完成后丢弃所属实例的 YouTube 状态缓存。 */
  invalidate() { this.ytCache = undefined; this.broadcastCache = undefined; this.broadcastGeneration++; }
  /** 频道授权成功后通知聊天；聊天检查点异常不能把成功授权误报成失败。 */
  async refreshChatCredentials() {
    this.invalidate();
    await this.chat.keyChanged().catch(() => { /* 聊天故障由独立状态上报，凭据保存事实保留。 */ });
  }
  /** 聊天和仪表盘共用场次查询及30秒缓存，避免空聊天额外持续消耗 REST 配额。 */
  private async readBroadcast(id: string, channelId: string): Promise<Broadcast | null> {
    const key = channelId + ":" + id;
    if (this.broadcastCache?.key === key && Date.now() - this.broadcastCache.at < 30_000) return this.broadcastCache.value;
    if (this.broadcastReading?.key === key && this.broadcastReading.generation === this.broadcastGeneration) return this.broadcastReading.value;
    const generation = this.broadcastGeneration;
    const reading = this.youtube.broadcast(id).then(value => { if (generation === this.broadcastGeneration) this.broadcastCache = { key, at: Date.now(), value }; return value; });
    this.broadcastReading = { key, generation, value: reading };
    try { return await reading; } finally { if (this.broadcastReading?.value === reading) this.broadcastReading = undefined; }
  }
  /** 每次发送前重新读取本机场次与停止意图；实际直播和聊天可用性来自 YouTube。 */
  private async observeChat(): Promise<LiveChatTarget> {
    const [state, tokens] = await Promise.all([this.control.state(), this.auth.tokens()]);
    if (!tokens || !state.broadcastId || ["idle", "stopping", "stopped"].includes(state.phase)) return { channelId: tokens?.channelId, broadcastId: state.broadcastId, live: false };
    const broadcast = await this.readBroadcast(state.broadcastId, tokens.channelId);
    const current = await this.control.state();
    if (current.broadcastId !== state.broadcastId || ["idle", "stopping", "stopped"].includes(current.phase)) return { channelId: tokens.channelId, broadcastId: current.broadcastId, live: false };
    return { channelId: tokens.channelId, broadcastId: state.broadcastId, live: broadcast?.status.lifeCycleStatus === "live", liveChatId: broadcast?.snippet.liveChatId, available: !!broadcast?.snippet.liveChatId };
  }
  /** 合并同一实例的并发读取，不与其他实例共享读取锁。 */
  async dashboard() {
    if (!this.reading) this.reading = this.readDashboard();
    try { return await this.reading; } finally { this.reading = undefined; }
  }
  /** 组合 OBS、媒体和有期限的 YouTube 状态，返回不含凭据的 DTO。 */
  private async readDashboard(): Promise<Dashboard> {
    const state = await this.control.state();
    const c = config(this.id);
    const [obs, media] = await Promise.all([
      this.obs.status(),
      scanMedia(c.mediaRoot).catch(e => ({ videos: [], music: [], error: safeError(e) })),
    ]);
    if(obs.problem)obs.problem={...obs.problem,target:{...obs.problem.target,instanceId:this.id}};
    let youtube: Dashboard["youtube"] = { connected: false, authorization: "missing" };
    try {
      const tokens = await this.auth.tokens();
      if (tokens) {
        const cacheKey = [tokens.channelId, state.broadcastId, state.streamId].join(":");
        if (this.ytCache?.key === cacheKey && Date.now() - this.ytCache.at < 30_000) youtube = this.ytCache.value;
        else {
          youtube = { connected: true, authorization: "present", query: "ready", channel: tokens.channel, channelId: tokens.channelId };
          try {
            const channel = await this.youtube.channel();
            youtube.channel = channel.title;
            if (state.broadcastId) youtube.lifecycle = (await this.readBroadcast(state.broadcastId, tokens.channelId))?.status.lifeCycleStatus || "missing";
            if (state.streamId) youtube.ingest = (await this.youtube.stream(state.streamId))?.status.streamStatus || "missing";
            youtube.checkedAt = new Date().toISOString();
          } catch (e) { const problem = problemFor(e, {target:{instanceId:this.id}, stage:"查询 YouTube", outcome:"rejected"}); const invalid = ["GOOGLE_AUTH","YOUTUBE_AUTH"].includes(problem.code); youtube = { connected: !invalid, authorization: invalid ? "invalid" : "present", query: "failed", channel: tokens.channel, channelId: tokens.channelId, error: safeError(e), problem }; }
          this.ytCache = { key: cacheKey, at: Date.now(), value: youtube };
        }
      }
    } catch (e) { youtube.error = safeError(e); youtube.query = "failed"; youtube.problem = problemFor(e, {target:{instanceId:this.id},domain:"youtube"}); }
    const operation = await this.commands.latest();
    return { operation, state, busy: this.control.busy || !!(operation && ["accepted", "running"].includes(operation.status)), obs, youtube, media, liveChat: await this.chat.status(), configuration: { broadcastDetails: true, liveChat: true, missing: missingConfig(this.id), privacy: c.privacy, madeForKids: c.madeForKids } };
  }
}
const registry = globalThis as typeof globalThis & { livePilotInstances?: Map<string, Service> };
/** 只允许注册实例进入控制层；配置冲突时拒绝控制以免串台。 */
export function service(id = "main") {
  requireInstance(id); validateInstances(); claimHost();
  const services = registry.livePilotInstances ??= new Map();
  let app = services.get(id);
  if (!app) { app = new Service(id); services.set(id, app); }
  return app;
}
