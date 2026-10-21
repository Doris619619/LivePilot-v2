/** 统一出站准入的故障回归：所有网络使用 Mock，证明关闭保护时无外发且日志不含敏感载荷。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { admitYouTubeCall, installYouTubeRuntime, withYouTubeContext, youtubeBackgroundInterval, youtubeFetch, YouTubePageGuard, type YouTubeAttempt, type YouTubeRuntimeEvent } from "@/core/youtube/usage";
import { YouTubeApi } from "@/core/youtube/api";
import { YouTubeAuth } from "@/core/youtube/auth";
import { VideoApi } from "@/core/youtube/video-api";
import { YouTubeLiveChat } from "@/core/youtube/live-chat";
import { youtubeCost, type YouTubeAdmission } from "@/shared/youtube-usage";
import { AppError } from "@/core/errors";
import { Store } from "@/core/storage";
const defaults = { instanceId: "main", purpose: "background", trigger: "dashboard" } as const;
let events: YouTubeRuntimeEvent[]; let attempts: YouTubeAttempt[];
/** 测试账本只计数并返回明确配额；没有真实 Cloud、Google 或本机授权读写。 */
function admission(attempt: YouTubeAttempt): YouTubeAdmission { return { allowed: true, attemptId: attempt.attemptId, project: "synthetic", quotaDay: "2026-10-20", ...youtubeCost(attempt.method), remaining: 9000, backgroundRemaining: 2000, activeInstances: 1, resetAt: Date.now() + 86400_000 }; }
/** 每例记录独立内存流水，防止前一例熔断影响下一例。 */
beforeEach(() => { events = []; attempts = []; installYouTubeRuntime({ async admit(attempt) { attempts.push(attempt); return admission(attempt); }, async record(event) { events.push(event); } }); });
/** 仅恢复本用例的模拟，不访问任何安装版状态。 */
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
/** 真实 API 使用合成授权；不让凭据刷新干扰出站入口断言。 */
function auth() {
  const value = new YouTubeAuth();
  vi.spyOn(value, "access").mockResolvedValue({ accessToken: "SECRET_TOKEN", refreshToken: "SECRET_REFRESH", channelId: "channel", channel: "Synthetic", expiresAt: Date.now() + 3600_000 });
  return value;
}
it("fails closed for REST reads, chat writes and resumable probes without an installed runtime", async () => {
  installYouTubeRuntime(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const credentials = auth();
  await expect(new YouTubeApi(credentials).broadcast("b")).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" });
  await expect(new YouTubeLiveChat(credentials).send("chat", "PRIVATE_CHAT", new AbortController().signal)).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" });
  await expect(new VideoApi(credentials).probe("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=PRIVATE_URI", 1)).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("OAuth refresh also fails closed before the token endpoint when Cloud protection is absent", async () => {
  installYouTubeRuntime(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const credentials = new YouTubeAuth(); vi.spyOn(credentials, "tokens").mockResolvedValue({ accessToken: "SECRET_EXPIRED", refreshToken: "SECRET_REFRESH", channelId: "channel", channel: "Synthetic", expiresAt: 0 });
  await expect(credentials.access()).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" }); expect(fetcher).not.toHaveBeenCalled();
});
it("rejects before creating a gRPC client when admission is unavailable", async () => {
  installYouTubeRuntime(); const createClient = vi.fn(); const client = new YouTubeLiveChat(auth(), { createClient });
  await expect(client.stream("chat", undefined, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" }); expect(createClient).not.toHaveBeenCalled();
});
it("stopping during Cloud admission never creates a late gRPC connection", async () => {
  let allow: (() => void) | undefined;
  installYouTubeRuntime({ admit(attempt) { return new Promise(resolve => { allow = () => resolve(admission(attempt)); }); }, async record(event) { events.push(event); } });
  const createClient = vi.fn(); const controller = new AbortController();
  const pending = new YouTubeLiveChat(auth(), { createClient }).stream("chat", undefined, controller.signal)[Symbol.asyncIterator]().next();
  await vi.waitFor(() => expect(allow).toBeTypeOf("function")); controller.abort(); allow!();
  await expect(pending).resolves.toEqual({ done: true, value: undefined }); expect(createClient).not.toHaveBeenCalled();
  expect(events.find(event => event.kind === "finish")).toMatchObject({ outcome: "cancelled", errorCode: "cancelled", streamBatches: 0 });
});
it.each(["rest", "grpc"] as const)("a disconnect while the %s start log is being saved prevents late Google I/O", async transport => {
  let connected = true; let release: (() => void) | undefined;
  installYouTubeRuntime({ async admit(attempt) { return admission(attempt); }, canSend: () => connected, async record(event) { events.push(event); if (event.kind === "start") await new Promise<void>(resolve => { release = resolve; }); } });
  const io = vi.fn(); const pending = transport === "rest" ? youtubeFetch("channels.list", defaults, io) : new YouTubeLiveChat(auth(), { createClient: io }).stream("chat", undefined, new AbortController().signal)[Symbol.asyncIterator]().next();
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); connected = false; release!();
  await expect(pending).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_OFFLINE" }); expect(io).not.toHaveBeenCalled();
  expect(events.find(event => event.kind === "finish")).toMatchObject({ outcome: "cancelled", errorCode: "cancelled" });
});
it("blocked admission records a decision rather than a real upstream attempt and preserves retry time", async () => {
  const retryAt = Date.now() + 1000;
  installYouTubeRuntime({ async admit(attempt) { return { ...admission(attempt), allowed: false, blockedUntil: retryAt }; }, async record(event) { events.push(event); } });
  const fetcher = vi.fn(); await expect(youtubeFetch("channels.list", defaults, fetcher)).rejects.toMatchObject({ retryAt, code: "YOUTUBE_PROTECTION_WAIT" });
  expect(fetcher).not.toHaveBeenCalled(); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: "decision", decision: "blocked" });
});
it("application budget pauses recheck Cloud within one minute so an administrator can restore admission", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const now = Date.now(); installYouTubeRuntime({ async admit(attempt) { return { ...admission(attempt), allowed: false, blockedUntil: now + 86400_000, code: "YOUTUBE_BUDGET" }; }, async record(event) { events.push(event); } });
  await expect(youtubeFetch("channels.list", defaults, vi.fn())).rejects.toMatchObject({ retryAt: now + 60_000, problem: { outcome: "not-sent", context: { retryAt: now + 60_000 } } });
});
it("an explicit quota response immediately blocks all Data API paths while OAuth revoke remains permitted", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "SECRET_RESPONSE", errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })).mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetcher);
  const credentials = auth(); await expect(new YouTubeApi(credentials).broadcast("b")).rejects.toMatchObject({ code: "YOUTUBE_DAILY_QUOTA" });
  await expect(new YouTubeLiveChat(credentials).send("chat", "PRIVATE_CHAT", new AbortController().signal)).rejects.toMatchObject({ code: "YOUTUBE_DAILY_QUOTA" });
  await expect(new VideoApi(credentials).probe("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=PRIVATE_URI", 1)).rejects.toMatchObject({ code: "YOUTUBE_DAILY_QUOTA" });
  await youtubeFetch("oauth.revoke", defaults, () => fetch("https://oauth2.googleapis.com/revoke"));
  expect(fetcher).toHaveBeenCalledTimes(2); expect(attempts.map(item => item.method)).toEqual(["liveBroadcasts.list", "oauth.revoke"]);
  expect(events.find(event => event.kind === "finish")).toMatchObject({ httpStatus: 403, errorCode: "quotaExceeded" });
  expect(JSON.stringify(events)).not.toMatch(/SECRET_|PRIVATE_|https:|Bearer|upload_id/);
});
it("every real retry needs a new attempt id and finishing a stream twice cannot duplicate its result", async () => {
  const first = await admitYouTubeCall("liveChatMessages.streamList", defaults);
  await first.finish({ outcome: "succeeded", streamBatches: 100, streamMessages: 200 }); await first.finish({ outcome: "failed" });
  const second = await admitYouTubeCall("liveChatMessages.streamList", defaults); await second.finish({ outcome: "cancelled" });
  expect(attempts).toHaveLength(2); expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId); expect(attempts.every(attempt => attempt.purpose === "chat-stream")).toBe(true);
  expect(attempts.every(attempt => attempt.retryCount === 0)).toBe(true);
  expect(events.filter(event => event.kind === "finish")).toHaveLength(2);
});
it("chat sends cannot inherit the control reserve and operation identity is retained", async () => {
  const operationId = "8fcb7944-2d45-46b5-92a6-3fdc5cc1be63";
  const call = await withYouTubeContext({ purpose: "control", trigger: "control-start", operationId }, () => admitYouTubeCall("liveChatMessages.insert", defaults)); await call.finish({ outcome: "succeeded" });
  expect(attempts[0]).toMatchObject({ operationId, purpose: "chat-send", trigger: "chat-send" });
});
it("an expired token refreshed during a control operation remains an authorization event", async () => {
  vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  const storage = new Store("synthetic"); vi.spyOn(storage, "exclusive").mockImplementation(async action => action()); vi.spyOn(storage, "write").mockResolvedValue();
  const credentials = new YouTubeAuth(storage);
  vi.spyOn(credentials, "tokens").mockResolvedValue({ accessToken: "SECRET_EXPIRED", refreshToken: "SECRET_REFRESH", channelId: "channel", channel: "Synthetic", expiresAt: 0 });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "SECRET_NEW", expires_in: 3600 })));
  await withYouTubeContext({ purpose: "control", trigger: "control-start", operationId: "8fcb7944-2d45-46b5-92a6-3fdc5cc1be63" }, () => credentials.access());
  expect(attempts[0]).toMatchObject({ method: "oauth.token", purpose: "authorization", trigger: "control-start", operationId: "8fcb7944-2d45-46b5-92a6-3fdc5cc1be63" });
});
it("network and server errors retain uncertainty without writing raw exceptions to logs", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("SECRET_TOKEN PRIVATE_URL")).mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(youtubeFetch("liveChatMessages.insert", defaults, fetcher)).rejects.toMatchObject({ code: "YOUTUBE_NETWORK" }); await youtubeFetch("liveChatMessages.insert", defaults, fetcher);
  expect(events.filter(event => event.kind === "finish").every(event => event.outcome === "unknown")).toBe(true); expect(JSON.stringify(events)).not.toContain("SECRET_TOKEN");
});
it("recording failures do not prevent a previously admitted request or successful result", async () => {
  installYouTubeRuntime({ async admit(attempt) { return admission(attempt); }, async record() { throw new Error("disk unavailable"); } });
  const fetcher = vi.fn(async () => new Response(null, { status: 200 })); await expect(youtubeFetch("channels.list", defaults, fetcher)).resolves.toBeInstanceOf(Response); expect(fetcher).toHaveBeenCalledOnce();
});
it("retains trusted protection failures rather than turning them into raw network failures", async () => {
  const error = new AppError("YOUTUBE_PROTECTION_WAIT", "安全错误", 429); await expect(youtubeFetch("channels.list", defaults, async () => { throw error; })).rejects.toBe(error);
});
it("100 active instances receive a longer inspection interval from the remaining project budget", async () => {
  installYouTubeRuntime({ async admit(attempt) { return { ...admission(attempt), activeInstances: 100 }; }, async record() {} });
  const call = await admitYouTubeCall("liveBroadcasts.list", defaults); await call.finish({ outcome: "succeeded" });
  expect(youtubeBackgroundInterval()).toBeGreaterThanOrEqual(8_639_000); expect(youtubeBackgroundInterval()).toBeLessThanOrEqual(8_640_000);
});
it("an offline denial cannot poison healthy inspection caches with a zero remaining budget", async () => {
  let allowed = true; installYouTubeRuntime({ async admit(attempt) { return { ...admission(attempt), allowed, backgroundRemaining: allowed ? 2000 : 0 }; }, async record() {} });
  const call = await admitYouTubeCall("liveBroadcasts.list", defaults); await call.finish({ outcome: "succeeded" }); allowed = false;
  await expect(admitYouTubeCall("liveBroadcasts.list", defaults)).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_WAIT" }); expect(youtubeBackgroundInterval()).toBe(300_000);
});
it("page guards reject repeated cursors, page twenty-one and late responses", () => {
  const repeated = new YouTubePageGuard(); repeated.next(""); repeated.next("next"); expect(() => repeated.next("next")).toThrow("安全上限");
  const limited = new YouTubePageGuard(); for (let i = 0; i < 20; i++) limited.next("p" + i); expect(() => limited.next("p20")).toThrow("安全上限");
  vi.useFakeTimers({ toFake: ["Date"] }); const timed = new YouTubePageGuard(); vi.setSystemTime(Date.now() + 30_000); expect(() => timed.check()).toThrow("超时");
});
it("all live REST endpoints including raw thumbnail upload pass the same method gate", async () => {
  const storage = new Store("synthetic"); vi.spyOn(storage, "read").mockResolvedValue({ name: "PRIVATE_NAME.png", mime: "image/png", data: "AAAA" });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const resource = new URL(url).pathname.split("/").at(-1);
    if ((init?.method || "GET") !== "GET") return Response.json({ id: "b" });
    if (resource === "channels") return Response.json({ items: [{ id: "channel", snippet: { title: "target" } }] });
    if (resource === "liveBroadcasts") return Response.json({ items: [{ id: "b", snippet: { title: "target", scheduledStartTime: "2030-01-01T00:00:00Z" }, status: { lifeCycleStatus: "ready" } }] });
    if (resource === "liveStreams") return Response.json({ items: [{ id: "s", snippet: { title: "target" }, status: { streamStatus: "ready" } }] });
    return Response.json({ items: resource === "playlists" ? [{ id: "PL_test", snippet: { title: "target" } }] : [] });
  }); vi.stubGlobal("fetch", fetcher);
  const api = new YouTubeApi(auth(), storage); await api.channel(); await api.broadcast("b"); await api.stream("s"); await api.createBroadcast("PRIVATE_TITLE"); await api.createStream("PRIVATE_TITLE"); await api.findBroadcast("target"); await api.findStream("target"); await api.bind("b", "s"); await api.transition("b", "live"); await api.playlists();
  await api.prepareBroadcast("b", { title: "PRIVATE_TITLE", description: "PRIVATE_DESCRIPTION", privacy: "private", madeForKids: false, playlistIds: ["PL_test"], thumbnail: { id: "8fcb7944-2d45-46b5-92a6-3fdc5cc1be63", name: "PRIVATE_NAME.png" } });
  expect(new Set(attempts.map(item => item.method))).toEqual(new Set(["channels.list", "liveBroadcasts.list", "liveStreams.list", "liveBroadcasts.insert", "liveStreams.insert", "liveBroadcasts.bind", "liveBroadcasts.transition", "playlists.list", "liveBroadcasts.update", "thumbnails.set", "playlistItems.list", "playlistItems.insert"]));
  expect(events.filter(event => event.kind === "start")).toHaveLength(fetcher.mock.calls.length); expect(events.filter(event => event.kind === "finish")).toHaveLength(fetcher.mock.calls.length); expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|SECRET_|AAAA|Bearer/);
});
it("resumable transport calls use their own zero-cost method and never invoke the retired publishing charge", async () => {
  const charge = vi.fn(); const api = new VideoApi(auth(), charge); vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 308 })));
  await api.probe("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=PRIVATE_URI", 10);
  expect(attempts[0].method).toBe("videos.upload.probe"); expect(youtubeCost(attempts[0].method)).toEqual({ bucket: "none", units: 0 }); expect(charge).not.toHaveBeenCalled();
});
it("repeated live recovery cursors stop after two pages and never become a false not-found result", async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [], nextPageToken: "repeated" })); vi.stubGlobal("fetch", fetcher);
  await expect(new YouTubeApi(auth()).findBroadcast("target")).rejects.toMatchObject({ code: "RECOVER" }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("publishing recovery applies the same cursor protection without starting another upload", async () => {
  const fetcher = vi.fn(async (url: string) => new URL(url).pathname.endsWith("/channels") ? Response.json({ items: [{ id: "channel", contentDetails: { relatedPlaylists: { uploads: "uploads" } } }] }) : Response.json({ items: [], nextPageToken: "repeated" })); vi.stubGlobal("fetch", fetcher);
  await expect(new VideoApi(auth()).recover("target", "channel")).rejects.toMatchObject({ code: "RECOVER" }); expect(fetcher).toHaveBeenCalledTimes(3); expect(attempts.some(attempt => attempt.method === "videos.insert")).toBe(false);
});
