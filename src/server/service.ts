import "server-only";
import type { Dashboard } from "@/shared/types";
import { Control } from "./control";
import { config, missingConfig } from "./config";
import { store } from "./storage";
import { resolveMedia, scanMedia } from "./media";
import { safeError } from "./errors";
import { LocalObsRuntime } from "./obs/runtime";
import { YouTubeAuth } from "./youtube/auth";
import { YouTubeApi } from "./youtube/api";
class Service {
  readonly auth = new YouTubeAuth();
  readonly youtube = new YouTubeApi(this.auth);
  readonly obs = new LocalObsRuntime();
  readonly control = new Control(this.obs, this.youtube, store(), async selection => ({
    video: await resolveMedia(config().mediaRoot, "videos", selection.video),
    music: await resolveMedia(config().mediaRoot, "music", selection.music),
  }));
  private ytCache?: { key: string; at: number; value: Dashboard["youtube"] };
  private reading?: Promise<Dashboard>;
  invalidate() { this.ytCache = undefined; }
  async dashboard() {
    if (!this.reading) this.reading = this.readDashboard();
    try { return await this.reading; } finally { this.reading = undefined; }
  }
  private async readDashboard(): Promise<Dashboard> {
    const state = await this.control.state();
    const c = config();
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
    return { state, busy: this.control.busy, obs, youtube, media, configuration: { missing: missingConfig(), privacy: c.privacy, madeForKids: c.madeForKids } };
  }
}
const globalService = globalThis as typeof globalThis & { livePilotV2?: Service };
export function service() { return globalService.livePilotV2 ??= new Service(); }
