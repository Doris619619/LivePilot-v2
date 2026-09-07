/** 按实例缓存独立控制服务；一个实例的长操作不阻塞其他实例。 */
import "server-only";
import type { Dashboard } from "@/shared/types";
import { Control } from "./control";
import { config, missingConfig, requireInstance, validateInstances } from "./config";
import { Store } from "./storage";
import { resolveMedia, scanMedia } from "./media";
import { safeError } from "./errors";
import { LocalObsRuntime } from "./obs/runtime";
import { YouTubeAuth } from "./youtube/auth";
import { YouTubeApi } from "./youtube/api";
import { ObsController } from "./obs/controller";
import { ObsProcessManager } from "./obs/process";
import { saveChannelBinding } from "./youtube/bindings";
class Service {
  readonly auth: YouTubeAuth;
  readonly youtube: YouTubeApi;
  readonly obs: LocalObsRuntime;
  readonly control: Control;
  /** 所有有状态依赖按实例创建；main 继续读取原来的 .data。 */
  constructor(readonly id: string) {
    /** 始终读取构造时选定实例的配置。 */
    const readConfig = () => config(id);
    const storage = new Store(readConfig().dataDir);
    this.auth = new YouTubeAuth(storage, id, tokens => saveChannelBinding(id, tokens));
    this.youtube = new YouTubeApi(this.auth);
    this.obs = new LocalObsRuntime(new ObsController(readConfig, { id, scene: "LIVE", video: "VIDEO", music: "MUSIC" }), new ObsProcessManager(readConfig));
    this.control = new Control(this.obs, this.youtube, storage, async selection => ({
      video: await resolveMedia(readConfig().mediaRoot, "videos", selection.video),
      music: await resolveMedia(readConfig().mediaRoot, "music", selection.music),
    }));
  }
  private ytCache?: { key: string; at: number; value: Dashboard["youtube"] };
  private reading?: Promise<Dashboard>;
  /** 控制操作完成后丢弃所属实例的 YouTube 状态缓存。 */
  invalidate() { this.ytCache = undefined; }
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
    let youtube: Dashboard["youtube"] = { connected: false };
    try {
      const tokens = await this.auth.tokens();
      if (tokens) {
        const cacheKey = [tokens.channelId, state.broadcastId, state.streamId].join(":");
        if (this.ytCache?.key === cacheKey && Date.now() - this.ytCache.at < 30_000) youtube = this.ytCache.value;
        else {
          youtube = { connected: true, channel: tokens.channel };
          try {
            const channel = await this.youtube.channel();
            youtube.channel = channel.title;
            if (state.broadcastId) youtube.lifecycle = (await this.youtube.broadcast(state.broadcastId))?.status.lifeCycleStatus || "missing";
            if (state.streamId) youtube.ingest = (await this.youtube.stream(state.streamId))?.status.streamStatus || "missing";
            youtube.checkedAt = new Date().toISOString();
          } catch (e) { youtube = { connected: false, channel: tokens.channel, error: safeError(e) }; }
          this.ytCache = { key: cacheKey, at: Date.now(), value: youtube };
        }
      }
    } catch (e) { youtube.error = safeError(e); }
    return { state, busy: this.control.busy, obs, youtube, media, configuration: { missing: missingConfig(this.id), privacy: c.privacy, madeForKids: c.madeForKids } };
  }
}
const registry = globalThis as typeof globalThis & { livePilotInstances?: Map<string, Service> };
/** 只允许注册实例进入控制层；配置冲突时拒绝控制以免串台。 */
export function service(id = "main") {
  requireInstance(id); validateInstances();
  const services = registry.livePilotInstances ??= new Map();
  let app = services.get(id);
  if (!app) { app = new Service(id); services.set(id, app); }
  return app;
}
