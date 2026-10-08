/** 合成授权和本地 gRPC 服务验证官方 protobuf 字段、游标、取消与发送不确定性，绝不访问真实 YouTube。 */
import * as grpc from "@grpc/grpc-js";
import { afterEach, expect, it, vi } from "vitest";
import { createLiveChatGrpcClient, liveChatGrpcService, YouTubeLiveChat } from "@/core/youtube/live-chat";
import { YouTubeApi } from "@/core/youtube/api";
import { YouTubeAuth } from "@/core/youtube/auth";
import { AppError } from "@/core/errors";

const token = "synthetic-youtube-token-only";
const auth = { access: vi.fn().mockResolvedValue({ accessToken: token, refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000, channelId: "owner", channel: "Synthetic owner" }) };
const servers: grpc.Server[] = [];
type TestCall = grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>>;

/** 绑定随机本地端口并只注入测试客户端，生产端点和真实授权不会被使用。 */
async function localChat(handle: (call: TestCall) => void) {
  const server = new grpc.Server(); servers.push(server);
  server.addService(liveChatGrpcService, { StreamList: handle });
  const port = await new Promise<number>((resolve, reject) => { server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)); });
  return new YouTubeLiveChat(auth, { createClient: () => createLiveChatGrpcClient("127.0.0.1:" + port, grpc.credentials.createInsecure()) });
}

/** 只关闭本测试创建的内存服务和模拟，不改动设备、凭据或直播状态。 */
afterEach(() => { for (const server of servers.splice(0)) server.forceShutdown(); vi.unstubAllGlobals(); });

/** 独立编码 protobuf varint，断言官方字段号而非使用被测 descriptor 自我验证。 */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
/** 生成 length-delimited wire 字段；字段号在测试中来自官方 proto 固定值。 */
function field(tag: number, value: string | Buffer): Buffer {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(tag * 8 + 2), varint(data.length), data]);
}

it("serializes official request tags and decodes independent official response bytes", () => {
  const method = liveChatGrpcService.StreamList;
  expect(method.path).toBe("/youtube.api.v3.V3DataLiveChatMessageService/StreamList");
  expect(method.responseStream).toBe(true); expect(method.requestStream).toBe(false);
  expect(method.requestSerialize({ liveChatId: "chat", pageToken: "cursor", part: ["id", "snippet", "authorDetails"] })).toEqual(Buffer.concat([field(1, "chat"), field(99, "cursor"), field(100, "id"), field(100, "snippet"), field(100, "authorDetails")]));
  const snippet = Buffer.concat([varint(8), varint(1), field(4, "2026-10-08T10:00:00Z"), field(301, "fallback-author"), field(19, field(1, "你好"))]);
  const message = Buffer.concat([field(101, "message-1"), field(2, snippet), field(3, Buffer.concat([field(10101, "viewer-1"), field(103, "观众")]))]);
  const response = method.responseDeserialize(Buffer.concat([field(100602, "next-cursor"), field(1007, message), field(2, "2026-10-08T11:00:00Z")]));
  expect(response).toMatchObject({ nextPageToken: "next-cursor", offlineAt: "2026-10-08T11:00:00Z", items: [{ id: "message-1", snippet: { type: "TEXT_MESSAGE_EVENT", textMessageDetails: { messageText: "你好" } }, authorDetails: { channelId: "viewer-1", displayName: "观众" } }] });
});

it("streams batches through real local gRPC with bearer metadata and reconnect cursor", async () => {
  let request: Record<string, unknown> | undefined; let authorization: grpc.MetadataValue[] = [];
  const chat = await localChat(call => {
    request = call.request; authorization = call.metadata.get("authorization");
    call.write({ nextPageToken: "next", items: [{ id: "m", snippet: { type: "TEXT_MESSAGE_EVENT", authorChannelId: "fallback", publishedAt: "2026-10-08T10:00:00Z", textMessageDetails: { messageText: "Hello" } }, authorDetails: { channelId: "viewer", displayName: "Sam" } }] });
    call.write({ nextPageToken: "last", offlineAt: "2026-10-08T11:00:00Z", items: [{ id: "end", snippet: { type: "CHAT_ENDED_EVENT" } }] }); call.end();
  });
  const batches = [];
  for await (const batch of chat.stream("chat-1", "saved-cursor", new AbortController().signal)) batches.push(batch);
  expect(request).toEqual({ liveChatId: "chat-1", pageToken: "saved-cursor", part: ["id", "snippet", "authorDetails"] });
  expect(authorization).toEqual(["Bearer " + token]);
  expect(batches[0]).toEqual({ nextPageToken: "next", messages: [{ id: "m", authorId: "viewer", author: "Sam", text: "Hello", publishedAt: Date.parse("2026-10-08T10:00:00Z"), type: "textMessageEvent" }] });
  expect(batches[1]).toMatchObject({ nextPageToken: "last", offlineAt: "2026-10-08T11:00:00Z", messages: [{ type: "chatEndedEvent" }] });
});

it("cancels an idle gRPC stream promptly and closes the upstream call", async () => {
  const controller = new AbortController();
  let connected!: () => void; const ready = new Promise<void>(resolve => { connected = resolve; });
  let cancelled!: () => void; const closed = new Promise<void>(resolve => { cancelled = resolve; });
  const chat = await localChat(call => { call.on("cancelled", cancelled); connected(); });
  const reader = chat.stream("chat", undefined, controller.signal)[Symbol.asyncIterator]();
  const pending = reader.next(); await ready; controller.abort();
  await expect(pending).resolves.toEqual({ done: true, value: undefined }); await closed;
});

it.each([
  [grpc.status.PERMISSION_DENIED, "sensitive " + token, "YOUTUBE_AUTH"],
  [grpc.status.FAILED_PRECONDITION, "sensitive " + token, "CHAT_UNAVAILABLE"],
  [grpc.status.RESOURCE_EXHAUSTED, "Resource has been exhausted (e.g. check quota) " + token, "CHAT_RATE"],
  [grpc.status.RESOURCE_EXHAUSTED, "quotaExceeded " + token, "CHAT_QUOTA"],
  [grpc.status.UNAVAILABLE, "raw network " + token, "CHAT_NETWORK"],
])("masks gRPC errors %s into safe categories", async (code, detail, expected) => {
  const chat = await localChat(call => { call.emit("error", Object.assign(new Error(detail), { code })); });
  const error = await chat.stream("chat", undefined, new AbortController().signal)[Symbol.asyncIterator]().next().catch(error => error);
  expect(error).toBeInstanceOf(AppError); expect(error.code).toBe(expected); expect(error.message).not.toContain(token); expect(error.message).not.toContain(detail);
});

it("sends exactly one validated text request and uses only returned message id", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "sent-1", sensitive: token }));
  const chat = new YouTubeLiveChat(auth, { fetch: fetcher });
  expect(await chat.send("chat", "[AI] @Sam Hi!", new AbortController().signal)).toEqual({ id: "sent-1" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet");
  const options = fetcher.mock.calls[0][1];
  expect(options.headers.Authorization).toBe("Bearer " + token); expect(options.redirect).toBe("error"); expect(options.cache).toBe("no-store");
  expect(JSON.parse(options.body)).toEqual({ snippet: { liveChatId: "chat", type: "textMessageEvent", textMessageDetails: { messageText: "[AI] @Sam Hi!" } } });
});

it("masks client creation and OAuth failures before opening a stream or sending", async () => {
  const failing = new YouTubeLiveChat(auth, { createClient: () => { throw new Error("client private " + token); } });
  const error = await failing.stream("chat", undefined, new AbortController().signal)[Symbol.asyncIterator]().next().catch(error => error);
  expect(error).toMatchObject({ code: "CHAT_NETWORK" }); expect(error.message).not.toContain(token);
  const fetcher = vi.fn(); const disconnected = new YouTubeLiveChat({ access: async () => { throw new AppError("GOOGLE_AUTH", "private " + token); } }, { fetch: fetcher });
  await expect(disconnected.send("chat", "Hello", new AbortController().signal)).rejects.toMatchObject({ code: "YOUTUBE_AUTH" }); expect(fetcher).not.toHaveBeenCalled();
});

it("rejects out-of-bound or empty text before making an external send", async () => {
  const fetcher = vi.fn(); const chat = new YouTubeLiveChat(auth, { fetch: fetcher });
  for (const text of [" ", "x".repeat(201)]) await expect(chat.send("chat", text, new AbortController().signal)).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([[401, "authError", "YOUTUBE_AUTH"], [403, "quotaExceeded", "CHAT_QUOTA"], [403, "rateLimitExceeded", "CHAT_RATE"], [403, "liveChatEnded", "CHAT_UNAVAILABLE"], [503, "raw " + token, "CHAT_UNCERTAIN"]])("classifies explicit send responses %s without exposing upstream diagnostics", async (status, reason, expected) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: token, errors: [{ reason }] } }, { status }));
  const error = await new YouTubeLiveChat(auth, { fetch: fetcher }).send("chat", "Hello", new AbortController().signal).catch(error => error);
  expect(error.code).toBe(expected); expect(error.message).not.toContain(token); expect(fetcher).toHaveBeenCalledTimes(1);
});

it("marks network failures and missing successful confirmations uncertain without retry", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("raw " + token));
  const chat = new YouTubeLiveChat(auth, { fetch: fetcher });
  await expect(chat.send("chat", "Hello", new AbortController().signal)).rejects.toMatchObject({ code: "CHAT_UNCERTAIN" });
  fetcher.mockResolvedValueOnce(Response.json({ raw: token }));
  await expect(chat.send("chat", "Hello", new AbortController().signal)).rejects.toMatchObject({ code: "CHAT_UNCERTAIN" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not call fetch on pre-cancel, but cancellation during send remains uncertain", async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => { options.signal?.addEventListener("abort", () => reject(new Error(token)), { once: true }); }));
  const chat = new YouTubeLiveChat(auth, { fetch: fetcher });
  await expect(chat.send("chat", "Hello", controller.signal)).rejects.toMatchObject({ code: "CHAT_NETWORK" }); expect(fetcher).not.toHaveBeenCalled();
  const live = new AbortController(); const pending = chat.send("chat", "Hello", live.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); live.abort();
  await expect(pending).rejects.toMatchObject({ code: "CHAT_UNCERTAIN" });
});

it.each([
  [403, ["quotaExceeded"], "YOUTUBE_DAILY_QUOTA"],
  [403, ["dailyLimitExceeded"], "YOUTUBE_DAILY_QUOTA"],
  [403, ["forbidden", "quotaExceeded"], "YOUTUBE_DAILY_QUOTA"],
  [403, ["rateLimitExceeded"], "YOUTUBE_QUOTA"],
  [429, [], "YOUTUBE_QUOTA"],
])("distinguishes observed broadcast daily quota from temporary rate HTTP %s", async (status, reasons, expected) => {
  const youtubeAuth = new YouTubeAuth();
  vi.spyOn(youtubeAuth, "access").mockResolvedValue({ accessToken: token, refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000, channelId: "owner", channel: "Synthetic owner" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "private " + token, errors: reasons.map(reason => ({ reason })) } }, { status })));
  const error = await new YouTubeApi(youtubeAuth).broadcast("synthetic-broadcast").catch(error => error);
  expect(error).toBeInstanceOf(AppError); expect(error.code).toBe(expected); expect(error.message).not.toContain(token); expect(error.message).not.toContain("private");
});
