import "server-only";
import { config } from "../config";
import { AppError } from "../errors";
import { YouTubeAuth } from "./auth";
export type Broadcast = { id: string; snippet: { title: string; actualStartTime?: string }; status: { lifeCycleStatus: string }; contentDetails?: { boundStreamId?: string } };
export type Stream = { id: string; snippet: { title: string }; status: { streamStatus: string }; cdn?: { ingestionInfo?: { streamName?: string; rtmpsIngestionAddress?: string } } };
type List<T> = { items?: T[]; nextPageToken?: string };
const reasons: Record<string, string> = {
  quotaExceeded: "YouTube API 配额已耗尽，请等待配额恢复。",
  liveStreamingNotEnabled: "YouTube Channel 尚未启用直播，请先在 YouTube Studio 启用。",
  insufficientLivePermissions: "此 Channel 没有直播权限，请检查 YouTube Studio。",
  livePermissionBlocked: "YouTube 当前禁止此 Channel 直播，请到 YouTube Studio 检查。",
  invalidTransition: "YouTube 当前状态不允许此操作，请检查 YouTube Studio；未开播的待播场次可能需要手动删除。",
  errorStreamInactive: "YouTube 尚未收到 OBS 推流，请检查 OBS 的网络和编码输出。",
  redundantTransition: "YouTube 已收到同一状态请求，请刷新状态后重试。",
};
export interface YouTubePort {
  channel(): Promise<{ id: string; title: string }>;
  broadcast(id: string): Promise<Broadcast | null>;
  stream(id: string): Promise<Stream | null>;
  createBroadcast(title: string): Promise<Broadcast>;
  createStream(title: string): Promise<Stream>;
  findBroadcast(title: string): Promise<Broadcast | null>;
  findStream(title: string): Promise<Stream | null>;
  bind(broadcastId: string, streamId: string): Promise<void>;
  transition(id: string, target: "live" | "complete"): Promise<void>;
}
export class YouTubeApi implements YouTubePort {
  constructor(readonly auth: YouTubeAuth) {}
  private async request<T>(resource: string, params: Record<string, string>, method = "GET", body?: unknown): Promise<T> {
    const token = await this.auth.access();
    let response: Response;
    try {
      response = await fetch("https://www.googleapis.com/youtube/v3/" + resource + "?" + new URLSearchParams(params), {
        method, headers: { Authorization: "Bearer " + token.accessToken, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000), cache: "no-store",
      });
    } catch { throw new AppError("YOUTUBE_NETWORK", "YouTube 请求超时或网络中断，结果尚未确认。请检查网络后重试，应用会先核对已有场次。", 502); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { errors?: { reason?: string }[] } };
      const reason = data.error?.errors?.[0]?.reason || "";
      throw new AppError(response.status === 401 ? "YOUTUBE_AUTH" : "YOUTUBE_API", response.status === 401 ? "YouTube 授权失效，请重新连接。" : reasons[reason] || "YouTube 请求失败（HTTP " + response.status + "），请检查 API 权限、配额与 YouTube Studio。", response.status === 401 ? 401 : 502);
    }
    return await response.json() as T;
  }
  async channel() {
    const data = await this.request<List<{ id: string; snippet: { title: string } }>>("channels", { part: "id,snippet", mine: "true" });
    if (data.items?.length !== 1) throw new AppError("CHANNEL", "未找到唯一的已授权 YouTube Channel。");
    return { id: data.items[0].id, title: data.items[0].snippet.title };
  }
  async broadcast(id: string) {
    const data = await this.request<List<Broadcast>>("liveBroadcasts", { part: "id,snippet,status,contentDetails", id });
    return data.items?.[0] || null;
  }
  async stream(id: string) {
    const data = await this.request<List<Stream>>("liveStreams", { part: "id,snippet,status,cdn", id });
    return data.items?.[0] || null;
  }
  async createBroadcast(title: string) {
    const c = config();
    return this.request<Broadcast>("liveBroadcasts", { part: "id,snippet,status,contentDetails" }, "POST", {
      snippet: { title, scheduledStartTime: new Date(Date.now() + 30_000).toISOString() },
      status: { privacyStatus: c.privacy, selfDeclaredMadeForKids: c.madeForKids },
      contentDetails: { enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 } },
    });
  }
  async createStream(title: string) {
    return this.request<Stream>("liveStreams", { part: "id,snippet,cdn,status,contentDetails" }, "POST", {
      snippet: { title }, cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" }, contentDetails: { isReusable: true },
    });
  }
  private async find<T extends { id: string; snippet: { title: string } }>(resource: string, title: string, params: Record<string, string>) {
    let pageToken = "";
    const matches: T[] = [];
    do {
      const data = await this.request<List<T>>(resource, { ...params, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
      matches.push(...(data.items || []).filter(item => item.snippet.title === title));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    if (matches.length > 1) throw new AppError("AMBIGUOUS", "YouTube 中存在多个同名恢复对象，请先到 YouTube Studio 核对。");
    return matches[0] || null;
  }
  async findBroadcast(title: string) { return this.find<Broadcast>("liveBroadcasts", title, { part: "id,snippet,status,contentDetails", mine: "true" }); }
  async findStream(title: string) { return this.find<Stream>("liveStreams", title, { part: "id,snippet,status,cdn", mine: "true" }); }
  async bind(broadcastId: string, streamId: string) {
    await this.request("liveBroadcasts/bind", { part: "id,contentDetails", id: broadcastId, streamId }, "POST");
  }
  async transition(id: string, target: "live" | "complete") {
    await this.request("liveBroadcasts/transition", { part: "id,status", id, broadcastStatus: target }, "POST");
  }
}
