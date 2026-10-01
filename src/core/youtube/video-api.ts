/** 普通视频 API：短 JSON 请求与 resumable 流式请求分离，错误和 session URI 不进入日志。 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { YouTubeAuth } from "./auth";
import { AppError, sleep } from "../errors";
import type { JobSpec } from "@/shared/publishing";
import type { z } from "zod";
import type { videoCopySchema } from "@/shared/video-metadata";
export type VideoResource = { id: string; snippet?: Record<string, unknown> & { title?: string; channelId?: string }; status?: Record<string, unknown> & { privacyStatus?: "private" | "public" | "unlisted"; uploadStatus?: string; publishAt?: string }; processingDetails?: { processingStatus?: string } };
export type UploadProbe = { offset: number; videoId?: string; expired?: boolean };
export type Charge = (units: number, upload: boolean) => Promise<void>;
export interface VideoPort {
  begin(job: JobSpec, marker: string): Promise<string>;
  probe(uri: string, total: number): Promise<UploadProbe>;
  chunk(uri: string, file: string, offset: number, total: number, bytes: number, mbps: number, signal?: AbortSignal): Promise<UploadProbe>;
  list(ids: string[]): Promise<VideoResource[]>;
  recover(marker: string, channelId: string): Promise<string[]>;
  thumbnail(videoId: string, file: string): Promise<void>;
  playlist(videoId: string, playlistId: string): Promise<void>;
  finalize(id: string, job: JobSpec, copy: z.infer<typeof videoCopySchema>, publishAt?: string): Promise<void>;
  unschedule(id: string): Promise<void>;
}
export class VideoApiError extends AppError {
  /** HTTP 错误分类只保留白名单 reason 和重试时间，不保存原响应。 */
  constructor(code: string, message: string, readonly retryable = false, readonly retryAfterMs = 0) { super(code, message, 409); }
}
/** 每次只信任 Google resumable endpoint，防止 Location 将 Bearer 转发给第三方。 */
export function validateSession(uri: string) {
  const url = new URL(uri);
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" || url.port || url.username || url.password || !url.pathname.startsWith("/upload/youtube/v3/videos")) throw new AppError("UPLOAD_SESSION", "YouTube 返回了无效的上传会话地址。");
  return url.href;
}
export class VideoApi implements VideoPort {
  /** 注入项目配额 admission；授权仍由现有实例 Auth 持有。 */
  constructor(private auth: YouTubeAuth, private charge: Charge) {}
  /** 固定 API 地址并重新取得短期 access token；不重放写请求。 */
  private async request(url: string, init: RequestInit = {}, units = 1, upload = false) {
    await this.charge(units, upload); return this.fetchAuthorized(url, init);
  }
  /** 过滤上游错误；网络中断被标记可恢复，副作用必须由 Runner 先核对。 */
  private async fetchAuthorized(url: string, init: RequestInit) {
    const token = await this.auth.access(); let response: Response;
    try { response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: "Bearer " + token.accessToken }, cache: "no-store", redirect: "manual", signal: init.signal || AbortSignal.timeout(30_000) }); }
    catch { throw new VideoApiError("VIDEO_NETWORK", "YouTube 网络中断，结果等待核对。", true); }
    if (response.status === 308 || response.status === 404) return response;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null;
      const reason = body?.error?.errors?.[0]?.reason;
      const retry = response.headers.get("retry-after"); const retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
      throw new VideoApiError(response.status === 401 ? "YOUTUBE_AUTH" : reason === "quotaExceeded" || reason === "dailyLimitExceeded" ? "VIDEO_QUOTA" : response.status === 429 || response.status >= 500 ? "VIDEO_RETRY" : "VIDEO_REJECTED", response.status === 401 ? "YouTube 授权无效，请重新连接原频道。" : "YouTube 未接受请求（HTTP " + response.status + "），请核对频道权限、配额和视频设置。", response.status === 429 || response.status >= 500 || reason === "quotaExceeded" || reason === "dailyLimitExceeded", retryAfterMs);
    }
    return response;
  }
  /** 有界 JSON 请求，part 指定的可写字段由业务合并。 */
  private async json<T>(resource: string, params: Record<string, string>, method = "GET", body?: unknown, units = 1): Promise<T> {
    const response = await this.request("https://www.googleapis.com/youtube/v3/" + resource + "?" + new URLSearchParams(params), { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, units);
    if (!response.ok) { await response.body?.cancel(); throw new VideoApiError("VIDEO_MISSING", "YouTube 对象不存在或不可访问。"); }
    try { return await response.json() as T; } catch { throw new VideoApiError("VIDEO_RESPONSE", "YouTube 响应不完整，结果等待核对。", true); }
  }
  /** 仅开始私密上传；唯一临时标题用于未知末块结果的精确核对。 */
  async begin(job: JobSpec, marker: string) {
    const response = await this.request("https://www.googleapis.com/upload/youtube/v3/videos?" + new URLSearchParams({ uploadType: "resumable", part: "snippet,status", notifySubscribers: String(job.profile.notifySubscribers) }), { method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(job.asset.size), "X-Upload-Content-Type": "application/octet-stream" }, body: JSON.stringify({ snippet: { title: marker, categoryId: job.profile.categoryId }, status: { privacyStatus: "private", selfDeclaredMadeForKids: job.profile.madeForKids } }) }, 0, true);
    const uri = response.headers.get("location"); await response.body?.cancel();
    if (!response.ok || !uri) throw new VideoApiError("UPLOAD_SESSION", "上传会话未确认；没有发送视频数据。", true);
    return validateSession(uri);
  }
  /** 探测也可能返回最终 video resource；404 交由 Runner 判断能否安全重新上传。 */
  async probe(uri: string, total: number) {
    const response = await this.fetchAuthorized(validateSession(uri), { method: "PUT", headers: { "Content-Length": "0", "Content-Range": "bytes */" + total } });
    return this.uploadResult(response, total);
  }
  /** 流式限速：每个小片发送前等待，限制整块内的瞬时速率而非上传后睡眠。 */
  async chunk(uri: string, file: string, offset: number, total: number, bytes: number, mbps: number, signal?: AbortSignal) {
    const size = Math.min(bytes, total - offset); const timeout = Math.max(60_000, size * 8 / (mbps * 1000) * 3 + 30_000);
    const stream = createReadStream(file, { start: offset, end: offset + size - 1, highWaterMark: 64 * 1024 });
    const start = Date.now(); let sent = 0;
    /** 等待期间响应 Agent 的安全停止信号，不将旧 offset 当作确认。 */
    async function* limited() { try { for await (const chunk of stream) { if (signal?.aborted) throw new Error("stopped"); sent += chunk.length; const wait = start + sent * 8 / (mbps * 1000) - Date.now(); if (wait > 0) await sleep(wait); yield chunk; } } finally { stream.destroy(); } }
    try {
      const response = await this.fetchAuthorized(validateSession(uri), { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), "Content-Range": `bytes ${offset}-${offset + size - 1}/${total}` }, body: Readable.toWeb(Readable.from(limited())) as ReadableStream, duplex: "half", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) } as RequestInit);
      return await this.uploadResult(response, total);
    } finally { stream.destroy(); }
  }
  /** 只接受连续、合法的服务器 offset；不根据本机已发送字节推进进度。 */
  private async uploadResult(response: Response, total: number): Promise<UploadProbe> {
    if (response.status === 404) { await response.body?.cancel(); return { offset: 0, expired: true }; }
    if (response.status === 308) {
      const range = response.headers.get("range"); const match = range ? /^bytes=0-(\d+)$/.exec(range) : null;
      await response.body?.cancel();
      if (range && !match) throw new VideoApiError("UPLOAD_RANGE", "YouTube 返回非连续上传进度，请人工核对。");
      const offset = match ? Number(match[1]) + 1 : 0;
      if (!Number.isSafeInteger(offset) || offset > total) throw new VideoApiError("UPLOAD_RANGE", "YouTube 上传进度无效。");
      return { offset };
    }
    let result: VideoResource;
    try { result = await response.json() as VideoResource; } catch { throw new VideoApiError("UPLOAD_RESULT", "上传响应中断，必须先探测现有会话。", true); }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.id || "")) throw new VideoApiError("UPLOAD_RESULT", "视频上传结果不完整，必须先核对。", true);
    return { offset: total, videoId: result.id };
  }
  /** 同频道批量核对；id 模式不附加 maxResults/pageToken。 */
  async list(ids: string[]) { const data = await this.json<{ items?: VideoResource[] }>("videos", { part: "snippet,status,processingDetails", id: [...new Set(ids)].join(",") }); return data.items || []; }
  /** 通过所属频道 uploads playlist 精确匹配临时标题，禁止相似度猜测。 */
  async recover(marker: string, channelId: string) {
    const channel = await this.json<{ items?: { id: string; contentDetails: { relatedPlaylists: { uploads: string } } }[] }>("channels", { part: "contentDetails", mine: "true" });
    if (channel.items?.length !== 1 || channel.items[0].id !== channelId) throw new VideoApiError("CHANNEL", "授权频道与任务不一致。");
    let pageToken = ""; const found: string[] = [];
    do {
      const result = await this.json<{ items?: { snippet: { title: string; resourceId: { videoId: string } } }[]; nextPageToken?: string }>("playlistItems", { part: "snippet", playlistId: channel.items[0].contentDetails.relatedPlaylists.uploads, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
      found.push(...(result.items || []).filter(v => v.snippet.title === marker).map(v => v.snippet.resourceId.videoId)); pageToken = result.nextPageToken || "";
    } while (pageToken);
    return found;
  }
  /** 图片由 Agent 本地读取，独立失败不重新上传视频。 */
  async thumbnail(videoId: string, file: string) {
    const info = await stat(file); const stream = createReadStream(file);
    try { const response = await this.request("https://www.googleapis.com/upload/youtube/v3/thumbnails/set?" + new URLSearchParams({ videoId, uploadType: "media" }), { method: "POST", headers: { "Content-Type": /\.png$/i.test(file) ? "image/png" : "image/jpeg", "Content-Length": String(info.size) }, body: Readable.toWeb(stream) as ReadableStream, duplex: "half", signal: AbortSignal.timeout(120_000) } as RequestInit, 50); if (!response.ok) throw new VideoApiError("THUMBNAIL", "缩略图上传未确认。"); await response.body?.cancel(); } finally { stream.destroy(); }
  }
  /** 对重试先查成员关系；只允许当前频道拥有的 Playlist。 */
  async playlist(videoId: string, playlistId: string) {
    const owned = await this.json<{ items?: { snippet: { channelId: string } }[] }>("playlists", { part: "snippet", id: playlistId }); const token = await this.auth.tokens();
    if (!owned.items?.length || owned.items[0].snippet.channelId !== token?.channelId) throw new VideoApiError("PLAYLIST", "所选 Playlist 不属于当前频道。");
    const existing = await this.json<{ items?: unknown[] }>("playlistItems", { part: "id", playlistId, videoId, maxResults: "1" });
    if (!existing.items?.length) await this.json("playlistItems", { part: "snippet" }, "POST", { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }, 50);
  }
  /** 更新时保留已存在的可写字段，不复制只读状态。 */
  async finalize(id: string, job: JobSpec, copy: z.infer<typeof videoCopySchema>, publishAt?: string) {
    const current = (await this.list([id]))[0]; if (!current) throw new VideoApiError("VIDEO_MISSING", "无法核对上传的视频。");
    if (current.snippet?.channelId !== job.profile.channelId) throw new VideoApiError("CHANNEL", "视频不属于任务频道。");
    const p = job.profile;
    const snippet = { ...pick(current.snippet, ["title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"]), ...copy, tags: p.tags, categoryId: p.categoryId };
    const status = { ...pick(current.status, ["privacyStatus", "license", "embeddable", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"]), privacyStatus: publishAt ? "private" : p.privacy, license: p.license, embeddable: p.embeddable, selfDeclaredMadeForKids: p.madeForKids, containsSyntheticMedia: p.containsSyntheticMedia, ...(publishAt ? { publishAt } : {}) };
    await this.json("videos", { part: "snippet,status" }, "PUT", { id, snippet, status }, 50);
  }
  /** 已公开视频不自动下架；私密视频通过移除 publishAt 取消排期。 */
  async unschedule(id: string) {
    const current = (await this.list([id]))[0]; if (!current) throw new VideoApiError("VIDEO_MISSING", "取消前无法核对视频。");
    if (current.status?.privacyStatus === "public") throw new VideoApiError("ALREADY_PUBLIC", "视频已经公开，未自动下架，请在 YouTube Studio 处理。");
    await this.json("videos", { part: "status" }, "PUT", { id, status: { ...pick(current.status, ["license", "embeddable", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"]), privacyStatus: current.status?.privacyStatus || "private" } }, 50);
    const after = (await this.list([id]))[0]; if (!after || after.status?.publishAt) throw new VideoApiError("CANCEL_UNCONFIRMED", "YouTube 取消排期尚未确认。", true);
  }
}
/** 只合并 API 明确可写字段，避免将 processing 等只读字段回写。 */
function pick(value: Record<string, unknown> | undefined, fields: string[]) { return Object.fromEntries(fields.filter(k => value?.[k] !== undefined).map(k => [k, value![k]])); }
