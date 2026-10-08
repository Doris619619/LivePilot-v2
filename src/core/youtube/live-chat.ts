/** Agent 的 YouTube 聊天 gRPC 读取与 REST 发送；凭据及原始上游异常仅留在请求内存中。 */
import * as grpc from "@grpc/grpc-js";
import { fromJSON, type ServiceDefinition } from "@grpc/proto-loader";
import type { LiveChatBatch, LiveChatMessage } from "@/shared/live-chat";
import { AppError, isAppError } from "../errors";
import type { YouTubeAuth } from "./auth";

// 最小 wire 子集保留官方 proto 的字段号；未知事件及字段由 protobuf 解码器安全跳过。
// 一手来源：https://developers.google.com/youtube/v3/live/streaming-live-chat#stream_listproto
// 官方示例为 Apache 2.0；内嵌 descriptor 避免 CLI / Electron bundle 遗失外部 .proto 资源。
const descriptor = { nested: { youtube: { nested: { api: { nested: { v3: { nested: {
  V3DataLiveChatMessageService: { methods: { StreamList: { requestType: "LiveChatMessageListRequest", responseType: "LiveChatMessageListResponse", responseStream: true, comment: "Official YouTube server-streaming chat RPC." } } },
  LiveChatMessageListRequest: { fields: { liveChatId: { type: "string", id: 1 }, pageToken: { type: "string", id: 99 }, part: { rule: "repeated", type: "string", id: 100 } } },
  LiveChatMessageListResponse: { fields: { offlineAt: { type: "string", id: 2 }, nextPageToken: { type: "string", id: 100602 }, items: { rule: "repeated", type: "LiveChatMessage", id: 1007 } } },
  LiveChatMessage: { fields: { id: { type: "string", id: 101 }, snippet: { type: "LiveChatMessageSnippet", id: 2 }, authorDetails: { type: "LiveChatMessageAuthorDetails", id: 3 } } },
  LiveChatMessageAuthorDetails: { fields: { channelId: { type: "string", id: 10101 }, displayName: { type: "string", id: 103 } } },
  LiveChatMessageSnippet: { fields: { type: { type: "EventType", id: 1 }, liveChatId: { type: "string", id: 201 }, authorChannelId: { type: "string", id: 301 }, publishedAt: { type: "string", id: 4 }, textMessageDetails: { type: "LiveChatTextMessageDetails", id: 19 } } },
  LiveChatTextMessageDetails: { fields: { messageText: { type: "string", id: 1 } } },
  EventType: { values: { INVALID_TYPE: 0, TEXT_MESSAGE_EVENT: 1, TOMBSTONE: 2, FAN_FUNDING_EVENT: 3, CHAT_ENDED_EVENT: 4, SPONSOR_ONLY_MODE_STARTED_EVENT: 5, SPONSOR_ONLY_MODE_ENDED_EVENT: 6, NEW_SPONSOR_EVENT: 7, USER_BANNED_EVENT: 10, SUPER_CHAT_EVENT: 15, SUPER_STICKER_EVENT: 16, MEMBER_MILESTONE_CHAT_EVENT: 17, MEMBERSHIP_GIFTING_EVENT: 18, GIFT_MEMBERSHIP_RECEIVED_EVENT: 19, POLL_EVENT: 20, GIFT_EVENT: 21 } },
} } } } } } } };

/** 导出真实 wire 定义供隔离的本地 gRPC 服务测试；不依赖文件路径或测试专用协议。 */
export const liveChatGrpcService = fromJSON(descriptor, { enums: String, defaults: false, arrays: true })["youtube.api.v3.V3DataLiveChatMessageService"] as ServiceDefinition;
type WireMessage = { id?: string; snippet?: { type?: string; authorChannelId?: string; publishedAt?: string; textMessageDetails?: { messageText?: string } }; authorDetails?: { channelId?: string; displayName?: string } };
type WireBatch = { items?: WireMessage[]; nextPageToken?: string; offlineAt?: string };
type WireRequest = { liveChatId: string; pageToken?: string; part: string[] };
export type LiveChatGrpcClient = grpc.Client & { StreamList(request: WireRequest, metadata: grpc.Metadata): grpc.ClientReadableStream<WireBatch> };
type Dependencies = { createClient?: () => LiveChatGrpcClient; fetch?: typeof fetch };

/** 从同一官方 descriptor 创建 TLS 客户端；参数可注入本地模拟端点以验证真实 protobuf。 */
export function createLiveChatGrpcClient(address = "youtube.googleapis.com:443", credentials = grpc.credentials.createSsl()): LiveChatGrpcClient {
  const Client = grpc.makeGenericClientConstructor(liveChatGrpcService, "V3DataLiveChatMessageService");
  return new Client(address, credentials, { "grpc.enable_retries": 0, "grpc.max_receive_message_length": 8 * 1024 * 1024 }) as unknown as LiveChatGrpcClient;
}

/** 只解析已知 OAuth 应用错误的类别，任何原始异常消息都被固定文案替换。 */
function authFailure(error: unknown): AppError {
  if (isAppError(error) && error.code === "YOUTUBE_QUOTA") return new AppError("CHAT_RATE", "YouTube 授权服务暂时限流，稍后自动重试。", 429);
  if (isAppError(error) && ["GOOGLE_NETWORK", "GOOGLE_UNAVAILABLE"].includes(error.code)) return new AppError("CHAT_NETWORK", "YouTube 授权服务暂时不可用。", 502);
  if (isAppError(error)) return new AppError("YOUTUBE_AUTH", "YouTube 授权不可用，请检查频道连接。", 409);
  return new AppError("CHAT_NETWORK", "无法读取 YouTube 聊天授权。", 502);
}

/** gRPC 的通用 RESOURCE_EXHAUSTED 无法证明每日配额耗尽；仅明确原因标记使用配额等待。 */
function streamFailure(error: unknown): AppError {
  const upstream = error as { code?: number; details?: string } | null;
  const detail = typeof upstream?.details === "string" ? upstream.details : "";
  if (upstream?.code === grpc.status.UNAUTHENTICATED || upstream?.code === grpc.status.PERMISSION_DENIED) return new AppError("YOUTUBE_AUTH", "YouTube 聊天授权不足或失效，请检查频道连接。", 409);
  if (upstream?.code === grpc.status.FAILED_PRECONDITION || upstream?.code === grpc.status.NOT_FOUND || upstream?.code === grpc.status.INVALID_ARGUMENT) return new AppError("CHAT_UNAVAILABLE", "此场直播聊天不可用、已关闭或已结束。", 409);
  if (upstream?.code === grpc.status.RESOURCE_EXHAUSTED) {
    if (/\b(?:quotaExceeded|dailyLimitExceeded)\b/.test(detail)) return new AppError("CHAT_QUOTA", "YouTube API 配额已耗尽，等待每日配额恢复。", 429);
    return new AppError("CHAT_RATE", "YouTube 聊天读取暂时限流，稍后自动重试。", 429);
  }
  return new AppError("CHAT_NETWORK", "YouTube 聊天连接中断，稍后自动重连。", 502);
}

/** 固定映射 REST 拒绝类别；5xx、未知响应和网络中断都不能证明消息未发送。 */
function sendFailure(status: number, reasons: string[]): AppError {
  if (status >= 500) return new AppError("CHAT_UNCERTAIN", "YouTube 聊天发送结果尚未确认，此条回复不会自动重发。", 502);
  if (reasons.some(reason => ["quotaExceeded", "dailyLimitExceeded"].includes(reason))) return new AppError("CHAT_QUOTA", "YouTube API 配额已耗尽，等待每日配额恢复。", 429);
  if (status === 429 || reasons.includes("rateLimitExceeded")) return new AppError("CHAT_RATE", "YouTube 聊天发送暂时限流，稍后再回复新消息。", 429);
  if (status === 401 || reasons.some(reason => ["authError", "insufficientPermissions", "forbidden"].includes(reason))) return new AppError("YOUTUBE_AUTH", "YouTube 聊天授权不足或失效，请检查频道连接。", 409);
  if ([400, 403, 404].includes(status)) return new AppError("CHAT_UNAVAILABLE", "YouTube 未接受此条聊天回复，请检查聊天权限和可用状态。", 409);
  return new AppError("CHAT_UNCERTAIN", "YouTube 聊天发送结果尚未确认，此条回复不会自动重发。", 502);
}

/** 将 protobuf 中的已知字段转为最小聊天 DTO，绝不转发整个上游响应。 */
function toBatch(response: WireBatch): LiveChatBatch {
  const messages: LiveChatMessage[] = [];
  for (const item of response.items || []) {
    const snippet = item.snippet;
    if (!item.id || !snippet) continue;
    const type = snippet.type === "TEXT_MESSAGE_EVENT" ? "textMessageEvent" : snippet.type === "CHAT_ENDED_EVENT" ? "chatEndedEvent" : "otherEvent";
    const publishedAt = Date.parse(snippet.publishedAt || "");
    if (type === "textMessageEvent" && (!Number.isFinite(publishedAt) || typeof snippet.textMessageDetails?.messageText !== "string")) continue;
    messages.push({ id: item.id, authorId: item.authorDetails?.channelId || snippet.authorChannelId || "", author: item.authorDetails?.displayName || "", text: snippet.textMessageDetails?.messageText || "", publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0, type });
  }
  return { messages, ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}), ...(response.offlineAt ? { offlineAt: response.offlineAt } : {}) };
}

export class YouTubeLiveChat {
  /** 仅接收 Agent 所属实例的授权；可注入模拟 I/O，默认固定 Google 官方端点。 */
  constructor(private auth: Pick<YouTubeAuth, "access">, private dependencies: Dependencies = {}) {}

  /** 一次调用对应一个 server stream；调用方保存每批 cursor 并负责断线退避，取消立即关闭 socket。 */
  async *stream(chatId: string, pageToken: string | undefined, signal: AbortSignal): AsyncIterable<LiveChatBatch> {
    if (signal.aborted) return;
    let token: Awaited<ReturnType<YouTubeAuth["access"]>>;
    try { token = await this.auth.access(); } catch (error) { throw authFailure(error); }
    if (signal.aborted) return;
    const metadata = new grpc.Metadata(); metadata.set("authorization", "Bearer " + token.accessToken);
    let client: LiveChatGrpcClient | undefined;
    let call: grpc.ClientReadableStream<WireBatch> | undefined;
    /** 取消只终止当前读取连接，不改动频道或广播状态。 */
    const cancel = () => { call?.cancel(); };
    try {
      client = (this.dependencies.createClient || createLiveChatGrpcClient)();
      call = client.StreamList({ liveChatId: chatId, part: ["id", "snippet", "authorDetails"], ...(pageToken ? { pageToken } : {}) }, metadata);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) call.cancel();
      for await (const response of call) {
        if (signal.aborted) return;
        yield toBatch(response as WireBatch);
      }
    } catch (error) {
      if (!signal.aborted) throw streamFailure(error);
    } finally {
      signal.removeEventListener("abort", cancel); call?.cancel(); client?.close();
    }
  }

  /** 无自动重试地发送一条文字；请求开始后的超时/取消视为结果不确定，禁止盲目重发。 */
  async send(chatId: string, text: string, signal: AbortSignal): Promise<{ id: string }> {
    if (signal.aborted) throw new AppError("CHAT_NETWORK", "聊天回复已取消，尚未发送。", 409);
    if (!chatId || !text.trim() || text.length > 200) throw new AppError("CHAT_UNAVAILABLE", "聊天回复为空或超过当前长度限制，尚未发送。", 400);
    let token: Awaited<ReturnType<YouTubeAuth["access"]>>;
    try { token = await this.auth.access(); } catch (error) { throw authFailure(error); }
    if (signal.aborted) throw new AppError("CHAT_NETWORK", "聊天回复已取消，尚未发送。", 409);
    let response: Response;
    try {
      response = await (this.dependencies.fetch || fetch)("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", {
        method: "POST", headers: { Authorization: "Bearer " + token.accessToken, "Content-Type": "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        body: JSON.stringify({ snippet: { liveChatId: chatId, type: "textMessageEvent", textMessageDetails: { messageText: text } } }),
      });
    } catch { throw new AppError("CHAT_UNCERTAIN", "YouTube 聊天发送结果尚未确认，此条回复不会自动重发。", 502); }
    const data = await response.json().catch(() => null) as { id?: unknown; error?: { errors?: { reason?: unknown }[] } } | null;
    if (!response.ok) throw sendFailure(response.status, (data?.error?.errors || []).flatMap(item => typeof item.reason === "string" ? [item.reason] : []));
    if (typeof data?.id !== "string" || !data.id) throw new AppError("CHAT_UNCERTAIN", "YouTube 未返回消息确认，此条回复不会自动重发。", 502);
    return { id: data.id };
  }
}
