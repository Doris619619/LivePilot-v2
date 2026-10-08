/** 模拟聊天端口验证真实运行语义：独立实例、持久恢复、取消、限频和未知发送不重放。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, seal, unseal } from "@/core/storage";
import { AppError } from "@/core/errors";
import { LiveChatRunner } from "@/core/live-chat/runner";
import { nextQuotaMidnight } from "@/core/live-chat/policy";
import type { Checkpoint } from "@/core/live-chat/checkpoint";
import { defaultLiveChatConfig, type LiveChatBatch, type LiveChatMessage, type LiveChatPorts, type LiveChatTarget } from "@/shared/live-chat";

class MemoryStore extends Store {
  readonly files = new Map<string, unknown>();
  /** 模拟原子磁盘读，独立复制以暴露未落盘或引用共享的错误。 */
  override async read<T>(name: string): Promise<T | null> { return this.files.has(name) ? structuredClone(this.files.get(name)) as T : null; }
  /** 模拟原子磁盘写，真实 seal/unseal 仍由被测运行器执行。 */
  override async write(name: string, value: unknown) { this.files.set(name, structuredClone(value)); }
}

class Feed {
  private batches: LiveChatBatch[] = [];
  private pending?: () => void;
  private failure?: Error;
  /** 推入一批模拟观众消息，并唤醒等待中的流。 */
  push(batch: LiveChatBatch) { this.batches.push(batch); this.pending?.(); }
  /** 模拟服务端断开；错误不经过真实 YouTube 网络。 */
  disconnect(error = new AppError("CHAT_NETWORK", "synthetic unsafe upstream token")) { this.failure = error; this.pending?.(); }
  /** 只在有数据、断开或取消时继续迭代，复现长驻 streamList 行为。 */
  async *stream(signal: AbortSignal): AsyncIterable<LiveChatBatch> {
    while (!signal.aborted) {
      if (this.failure) throw this.failure;
      if (this.batches.length) { yield this.batches.shift()!; continue; }
      await new Promise<void>(resolve => {
        const wake = () => { signal.removeEventListener("abort", wake); this.pending = undefined; resolve(); };
        this.pending = wake; signal.addEventListener("abort", wake, { once: true });
        if (signal.aborted) wake();
      });
    }
  }
}

const runners: LiveChatRunner[] = [];
/** 提供确定性时钟、模拟直播身份和隔离的消息流，不执行任何外部请求。 */
function fixture(store = new MemoryStore("synthetic")) {
  let target: LiveChatTarget = { channelId: "channel", broadcastId: "broadcast", liveChatId: "chat", live: true, available: true };
  let configured = true;
  const feeds: Feed[] = [];
  const ports: LiveChatPorts = {
    observe: vi.fn(async () => structuredClone(target)), configured: vi.fn(async () => configured),
    stream: vi.fn((_id, _cursor, signal) => { const feed = new Feed(); feeds.push(feed); return feed.stream(signal); }),
    generate: vi.fn(async (_config, message) => "[AI] @" + message.author + " Welcome!"),
    send: vi.fn(async () => ({ id: "sent" })), now: () => Date.now(),
  };
  const runner = new LiveChatRunner(store, ports); runners.push(runner);
  return { runner, ports, feeds, store, setTarget: (value: LiveChatTarget) => { target = value; }, setConfigured: (value: boolean) => { configured = value; } };
}
/** 创建有效且新于启用时刻的普通文字消息，允许调用者覆盖身份与时间。 */
function message(id: string, overrides: Partial<LiveChatMessage> = {}): LiveChatMessage { return { id, authorId: "viewer-" + id, author: "Viewer", text: "hello " + id, publishedAt: Date.now(), type: "textMessageEvent", ...overrides }; }
/** 推进模拟时钟并排空异步存储与生成回调。 */
async function advance(ms = 600) { await vi.advanceTimersByTimeAsync(ms); }
/** 解密被测检查点以确认游标和发送意图确实落盘。 */
async function checkpoint(store: MemoryStore) { return unseal<Checkpoint>((await store.read<string>("live-chat.enc"))!); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010"); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); });
afterEach(async () => { for (const runner of runners.splice(0)) await runner.stop(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("LiveChatRunner", () => {
  it("reports enabled waiting-for-key defaults without an encryption key, disk writes or YouTube calls", async () => {
    vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", ""); const f = fixture(); f.setConfigured(false);
    expect(await f.runner.status()).toMatchObject({ config: { enabled: true }, configured: false, state: "needs_key", queued: 0 });
    f.runner.start(); await advance(); expect(f.ports.observe).not.toHaveBeenCalled(); expect(f.ports.stream).not.toHaveBeenCalled(); expect(f.store.files.size).toBe(0);
  });

  it("filters enable-time history, own-channel messages, non-text, duplicate ids and same-viewer spam", async () => {
    const f = fixture(); f.runner.start(); await advance();
    f.feeds[0].push({ messages: [message("old", { publishedAt: Date.now() - 1000 }), message("own", { authorId: "channel" }), message("event", { type: "superChatEvent" }), message("a", { authorId: "viewer", text: "Hi" }), message("a"), message("spam", { authorId: "viewer", text: " hi " }), message("b", { authorId: "other", text: "Hi" })], nextPageToken: "cursor-1" });
    await advance(100); expect(f.ports.send).toHaveBeenCalledOnce(); await advance(5000); expect(f.ports.send).toHaveBeenCalledTimes(2);
    expect((await f.runner.status()).recent.filter(entry => entry.status === "sent").map(entry => entry.id)).toEqual(["a", "b"]);
    expect(await checkpoint(f.store)).toMatchObject({ pageToken: "cursor-1", queue: [] });
  });

  it("caps the backlog at 100, expires messages after two minutes and retains only 30 recent entries", async () => {
    const f = fixture(); vi.mocked(f.ports.generate).mockImplementation((_config, _message, _context, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true })));
    f.runner.start(); await advance(); f.feeds[0].push({ messages: Array.from({ length: 120 }, (_, index) => message("bulk" + index)) }); await advance(200);
    expect(await f.runner.status()).toMatchObject({ queued: 100, skipped: 20, recent: expect.any(Array) }); expect((await f.runner.status()).recent).toHaveLength(30);
    expect((await checkpoint(f.store)).queue[0].id).toBe("bulk20");
    await advance(121000); expect(await f.runner.status()).toMatchObject({ queued: 0, skipped: 120 }); expect(f.ports.send).not.toHaveBeenCalled();
  });

  it("persists manual disable across runner recreation and starts re-enabled interaction from the new activation time", async () => {
    const f = fixture(); await f.runner.configure({ ...defaultLiveChatConfig, enabled: false }); await f.runner.stop();
    const next = fixture(f.store); next.runner.start(); await advance(); expect(await next.runner.status()).toMatchObject({ state: "disabled" }); expect(next.ports.observe).not.toHaveBeenCalled();
    const earlier = Date.now(); await advance(1000); await next.runner.configure(defaultLiveChatConfig); await advance(); next.feeds[0].push({ messages: [message("history", { publishedAt: earlier }), message("fresh")] }); await advance();
    expect(next.ports.send).toHaveBeenCalledOnce(); expect((await next.runner.status()).recent.find(entry => entry.id === "history")?.status).toBe("skipped");
  });

  it.each(["disable", "stop-live", "switch-broadcast"] as const)("cancels generation and clears the queue on %s, even if the provider ignores abort", async action => {
    const f = fixture(); let release!: (text: string) => void;
    vi.mocked(f.ports.generate).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("late"), message("pending")] }); await advance(200);
    if (action === "disable") await f.runner.configure({ ...defaultLiveChatConfig, enabled: false });
    else f.setTarget({ channelId: "channel", broadcastId: action === "switch-broadcast" ? "new" : "broadcast", liveChatId: action === "switch-broadcast" ? "new-chat" : "chat", live: action === "switch-broadcast" });
    await advance(); release("[AI] @Viewer stale reply"); await advance(); expect(f.ports.send).not.toHaveBeenCalled(); expect((await f.runner.status()).queued).toBe(0);
  });

  it("reobserves the exact channel and broadcast immediately before send", async () => {
    const f = fixture(); vi.mocked(f.ports.generate).mockImplementationOnce(async () => { f.setTarget({ channelId: "other-channel", broadcastId: "broadcast", liveChatId: "chat", live: true }); return "[AI] stale identity"; });
    f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("identity")] }); await advance(200); expect(f.ports.send).not.toHaveBeenCalled();
  });

  it("honors the configured send interval without a daily cap, and keeps instance state isolated", async () => {
    const one = fixture(); const two = fixture(); await one.runner.configure({ ...defaultLiveChatConfig, intervalSeconds: 60 });
    one.runner.start(); two.runner.start(); await advance(); one.feeds[0].push({ messages: [message("one"), message("two")] }); two.feeds[0].push({ messages: [message("one")] }); await advance(200);
    expect(one.ports.send).toHaveBeenCalledOnce(); expect(two.ports.send).toHaveBeenCalledOnce(); await advance(59900); expect(one.ports.send).toHaveBeenCalledTimes(2); expect((await one.runner.status()).sent).toBe(2); expect((await two.runner.status()).sent).toBe(1);
  });

  it("persists sending before the external request and never resends a timed-out result after reconnect or restart", async () => {
    const f = fixture(); vi.mocked(f.ports.send).mockImplementationOnce(async () => { expect((await checkpoint(f.store)).sending?.message.id).toBe("uncertain"); throw new AppError("CHAT_UNCERTAIN", "raw OAuth request secret"); });
    f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("uncertain")], nextPageToken: "saved-cursor" }); await advance(200);
    expect((await f.runner.status()).recent.find(entry => entry.id === "uncertain")).toMatchObject({ status: "uncertain", reason: expect.not.stringContaining("secret") }); await f.runner.stop();
    const next = fixture(f.store); next.runner.start(); await advance(1500); expect(next.ports.stream).toHaveBeenCalledWith("chat", "saved-cursor", expect.any(AbortSignal)); next.feeds[0].push({ messages: [message("uncertain")] }); await advance(); expect(next.ports.send).not.toHaveBeenCalled();
  });

  it("turns a crash checkpoint into uncertain without generating or sending it again", async () => {
    const f = fixture(); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("seed")] }); await advance(200); await f.runner.stop();
    const saved = await checkpoint(f.store); saved.sending = { message: message("crashed"), reply: "[AI] possibly sent", at: Date.now() }; saved.seen.push({ id: "crashed", at: Date.now() }); await f.store.write("live-chat.enc", seal(saved));
    const next = fixture(f.store); expect((await next.runner.status()).recent.find(entry => entry.id === "crashed")?.status).toBe("uncertain"); next.runner.start(); await advance(); next.feeds[0].push({ messages: [message("crashed")] }); await advance(); expect(next.ports.send).not.toHaveBeenCalled(); expect((await checkpoint(f.store)).sending).toBeUndefined();
  });

  it("resumes a disconnected stream from its durable cursor after bounded backoff", async () => {
    const f = fixture(); f.runner.start(); await advance(); f.feeds[0].push({ messages: [], nextPageToken: "resume-cursor" }); await advance(100); f.feeds[0].disconnect(); await advance(100);
    expect(await f.runner.status()).toMatchObject({ state: "reconnecting", nextRetryAt: expect.any(Number) }); expect(f.ports.stream).toHaveBeenCalledOnce(); await advance(1500);
    expect(f.ports.stream).toHaveBeenLastCalledWith("chat", "resume-cursor", expect.any(AbortSignal));
  });

  it.each(["AI_CONFIG", "AI_BALANCE", "YOUTUBE_AUTH"])("blocks %s until an explicit key or config operation, without repeating paid generation", async code => {
    const f = fixture(); vi.mocked(f.ports.generate).mockRejectedValueOnce(new AppError(code, "raw upstream token secret")); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("blocked")] }); await advance(200);
    expect(await f.runner.status()).toMatchObject({ state: "needs_attention", queued: 0, message: expect.not.stringContaining("secret") }); const reads = vi.mocked(f.ports.observe).mock.calls.length; await advance(60000); expect(f.ports.generate).toHaveBeenCalledOnce(); expect(f.ports.observe).toHaveBeenCalledTimes(reads);
    await f.runner.keyChanged(); await advance(); f.feeds.at(-1)!.push({ messages: [message("recovered")] }); await advance(); expect(f.ports.send).toHaveBeenCalledOnce();
  });

  it("waits for a new broadcast when chat is unavailable", async () => {
    const f = fixture(); f.runner.start(); await advance(); f.feeds[0].disconnect(new AppError("CHAT_UNAVAILABLE", "raw upstream disabled response")); await advance(); expect(await f.runner.status()).toMatchObject({ state: "unavailable" }); await advance(20000); expect(f.ports.stream).toHaveBeenCalledOnce();
    f.setTarget({ channelId: "channel", broadcastId: "second", liveChatId: "second-chat", live: true }); await advance(); expect(f.ports.stream).toHaveBeenCalledTimes(2);
  });

  it("waits for the next Pacific midnight on confirmed chat quota exhaustion", async () => {
    vi.setSystemTime(new Date("2026-03-08T09:59:00Z")); const f = fixture(); f.runner.start(); await advance(); f.feeds[0].disconnect(new AppError("CHAT_QUOTA", "quota raw response")); await advance(100);
    const expected = Date.parse("2026-03-09T07:00:00Z"); expect(nextQuotaMidnight(Date.now())).toBe(expected); expect(await f.runner.status()).toMatchObject({ state: "quota_wait", nextRetryAt: expected }); await advance(60000); expect(f.ports.stream).toHaveBeenCalledOnce();
    vi.setSystemTime(expected + 1); await advance(); expect(f.ports.stream).toHaveBeenCalledTimes(2);
  });

  it("uses author ids rather than matching display names for conversation context", async () => {
    const f = fixture(); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("first", { authorId: "alice", author: "Same Name" }), message("second", { authorId: "bob", author: "Same Name" }), message("third", { authorId: "alice", author: "Same Name" })] }); await advance(10200);
    expect(vi.mocked(f.ports.generate).mock.calls[1][2]).toEqual([]); expect(vi.mocked(f.ports.generate).mock.calls[2][2]).toMatchObject([{ id: "first", authorId: "alice", status: "sent" }]);
  });

  it("maps existing observer auth failures to a permanent safe state and unknown errors to a fixed reconnect message", async () => {
    const f = fixture(); vi.mocked(f.ports.observe).mockRejectedValueOnce(new AppError("GOOGLE_AUTH", "raw refresh token")); f.runner.start(); await advance(); expect(await f.runner.status()).toMatchObject({ state: "needs_attention", message: expect.not.stringContaining("token") });
    await f.runner.keyChanged(); vi.mocked(f.ports.observe).mockRejectedValueOnce(new Error("raw password response")); await advance(); expect(await f.runner.status()).toMatchObject({ state: "reconnecting", message: expect.not.stringContaining("password") });
  });

  it("stops networking on a failed checkpoint write and reports a safe state without an unhandled stream rejection", async () => {
    const f = fixture(); f.runner.start(); await advance(); const writes = vi.spyOn(f.store, "write").mockRejectedValue(new Error("raw disk path secret"));
    f.feeds[0].push({ messages: [message("disk-failed")] }); await advance(); expect(await f.runner.status()).toMatchObject({ state: "needs_attention", message: expect.not.stringContaining("secret") }); expect(f.ports.send).not.toHaveBeenCalled();
    writes.mockRestore(); await f.runner.configure(defaultLiveChatConfig); await advance(); expect((await f.runner.status()).state).toBe("connecting"); f.feeds.at(-1)!.push({ messages: [] }); await advance(); expect((await f.runner.status()).state).toBe("running");
  });

  it("rejects invalid send intervals without changing persisted configuration", async () => {
    const f = fixture(); await expect(f.runner.configure({ ...defaultLiveChatConfig, intervalSeconds: 4 })).rejects.toMatchObject({ code: "INPUT" });
    expect((await f.runner.status()).config.intervalSeconds).toBe(5); expect(f.store.files.size).toBe(0);
  });

  it("keeps a corrupt checkpoint untouched and returns a safe chat state without breaking other dashboard data", async () => {
    const f = fixture(); f.store.files.set("live-chat.enc", "corrupt encrypted contents");
    expect(await f.runner.status()).toMatchObject({ state: "needs_attention", queued: 0, recent: [] }); f.runner.start(); await advance(); expect((await f.runner.status()).state).toBe("needs_attention"); expect(f.ports.observe).not.toHaveBeenCalled(); expect(f.ports.send).not.toHaveBeenCalled();
    await expect(f.runner.configure(defaultLiveChatConfig)).rejects.toMatchObject({ code: "CHAT_STORAGE" }); expect(f.store.files.get("live-chat.enc")).toBe("corrupt encrypted contents");
  });

  it("keeps connecting until a stream batch arrives and persists successful YouTube message ids", async () => {
    const f = fixture(); f.runner.start(); await advance(); expect((await f.runner.status()).state).toBe("connecting"); f.feeds[0].push({ messages: [message("receipt")] }); await advance();
    expect((await f.runner.status()).state).toBe("running"); expect((await checkpoint(f.store)).receipts).toEqual([{ messageId: "receipt", sentMessageId: "sent", at: expect.any(Number), target: JSON.stringify(["channel", "broadcast", "chat"]) }]);
  });

  it("clears pending messages on process exit while retaining cursor and sent facts", async () => {
    const f = fixture(); await f.runner.configure({ ...defaultLiveChatConfig, intervalSeconds: 60 }); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("sent-before-exit"), message("pending-exit")], nextPageToken: "exit-cursor" }); await advance(200); expect((await f.runner.status()).queued).toBe(1);
    await f.runner.stop(); expect(await checkpoint(f.store)).toMatchObject({ queue: [], sent: 1, pageToken: "exit-cursor" }); expect((await f.runner.status()).recent.find(entry => entry.id === "pending-exit")?.status).toBe("skipped");
  });

  it("never sends when the sending checkpoint cannot be durably written", async () => {
    const f = fixture(); const original = f.store.write.bind(f.store); f.runner.start(); await advance();
    vi.spyOn(f.store, "write").mockImplementation(async (name, value) => {
      if (name === "live-chat.enc" && unseal<Checkpoint>(value as string).sending) throw new Error("disk failed with raw token path");
      await original(name, value);
    }); f.feeds[0].push({ messages: [message("no-checkpoint")] }); await advance();
    expect(f.ports.send).not.toHaveBeenCalled(); expect((await f.runner.status()).state).toBe("needs_attention"); const observations = vi.mocked(f.ports.observe).mock.calls.length; await advance(10000); expect(f.ports.observe).toHaveBeenCalledTimes(observations);
  });

  it("welcomes each new author once per broadcast, while preserving author history through a style change", async () => {
    const f = fixture(); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("a1", { authorId: "alice" }), message("a2", { authorId: "alice" }), message("b1", { authorId: "bob" })] }); await advance(10200);
    expect(vi.mocked(f.ports.generate).mock.calls.map(call => call[1].firstMessage)).toEqual([true, false, true]);
    await f.runner.configure({ ...defaultLiveChatConfig, preset: "gentle" }); await advance(); f.feeds.at(-1)!.push({ messages: [message("a3", { authorId: "alice" })] }); await advance(5000); expect(vi.mocked(f.ports.generate).mock.calls.at(-1)![1].firstMessage).toBe(false);
    f.setTarget({ channelId: "channel", broadcastId: "next", liveChatId: "next-chat", live: true }); await advance(); f.feeds.at(-1)!.push({ messages: [message("a4", { authorId: "alice" })] }); await advance(5000); expect(vi.mocked(f.ports.generate).mock.calls.at(-1)![1].firstMessage).toBe(true);
  });

  it("waits for an old ignored-abort generator to finish before starting consumers after storage recovery", async () => {
    const f = fixture(); let release!: (value: string) => void; vi.mocked(f.ports.generate).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("old-generation")] }); await advance(200);
    const writes = vi.spyOn(f.store, "write").mockRejectedValue(new Error("synthetic disk failure")); f.feeds[0].push({ messages: [message("disk-break")] }); await advance(); expect((await f.runner.status()).state).toBe("needs_attention");
    writes.mockRestore(); await f.runner.configure(defaultLiveChatConfig); await advance(2000); expect(f.ports.stream).toHaveBeenCalledOnce();
    release("[AI] stale reply"); await advance(); expect(f.ports.stream).toHaveBeenCalledTimes(2); f.feeds[1].push({ messages: [message("after-recovery")] }); await advance(); expect(f.ports.send).toHaveBeenCalledOnce();
  });

  it("does not borrow a late success from the old broadcast as context in the new one", async () => {
    const f = fixture(); let release!: (value: { id: string }) => void; vi.mocked(f.ports.send).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("old-send", { authorId: "alice" })] }); await advance(200);
    f.setTarget({ channelId: "channel", broadcastId: "new", liveChatId: "new-chat", live: true }); await advance(); release({ id: "old-receipt" }); await advance(); f.feeds.at(-1)!.push({ messages: [message("new-message", { authorId: "alice" })] }); await advance(5000);
    expect(vi.mocked(f.ports.generate).mock.calls.at(-1)![2]).toEqual([]);
  });

  it("bounds first-speaker history and conservatively avoids repeated welcomes when the author cap is full", async () => {
    const f = fixture(); f.runner.start(); await advance(); await f.runner.stop(); const saved = await checkpoint(f.store); saved.seenAuthors = Array.from({ length: 10000 }, (_, index) => "author-" + index); await f.store.write("live-chat.enc", seal(saved));
    const next = fixture(f.store); next.runner.start(); await advance(); next.feeds[0].push({ messages: [message("unknown-author")] }); await advance();
    expect(vi.mocked(next.ports.generate).mock.calls[0][1].firstMessage).toBe(false); expect((await checkpoint(f.store)).seenAuthors).toHaveLength(10000);
  });

  it.each([true, false])("stops all networking and restores persisted config when saving enabled=%s fails", async enabled => {
    const f = fixture(); await f.runner.configure({ ...defaultLiveChatConfig, enabled: !enabled }); f.runner.start(); await advance(); const observations = vi.mocked(f.ports.observe).mock.calls.length;
    const writes = vi.spyOn(f.store, "write").mockRejectedValue(new Error("synthetic failed config persistence"));
    await expect(f.runner.configure({ ...defaultLiveChatConfig, enabled })).rejects.toMatchObject({ code: "CHAT_STORAGE" });
    expect(await f.runner.status()).toMatchObject({ state: "needs_attention", config: { enabled: !enabled } }); expect((await checkpoint(f.store)).config.enabled).toBe(!enabled);
    await advance(2000); expect(f.ports.observe).toHaveBeenCalledTimes(observations); expect(f.ports.send).not.toHaveBeenCalled();
    writes.mockRestore(); await f.runner.configure({ ...defaultLiveChatConfig, enabled }); await advance(); expect((await f.runner.status()).config.enabled).toBe(enabled);
  });

  it("preserves the durable block and stops loops when keyChanged cannot save its reset", async () => {
    const f = fixture(); vi.mocked(f.ports.generate).mockRejectedValueOnce(new AppError("AI_CONFIG", "synthetic invalid key")); f.runner.start(); await advance(); f.feeds[0].push({ messages: [message("invalid-key")] }); await advance(); const observations = vi.mocked(f.ports.observe).mock.calls.length;
    const writes = vi.spyOn(f.store, "write").mockRejectedValue(new Error("synthetic failed key reset persistence")); await expect(f.runner.keyChanged()).rejects.toMatchObject({ code: "CHAT_STORAGE" });
    expect((await checkpoint(f.store)).block?.code).toBe("AI_CONFIG"); expect((await f.runner.status()).state).toBe("needs_attention"); await advance(2000); expect(f.ports.observe).toHaveBeenCalledTimes(observations); writes.mockRestore();
  });

  it("distinguishes confirmed observer daily quota exhaustion from temporary YouTube throttling", async () => {
    const daily = fixture(); vi.mocked(daily.ports.observe).mockRejectedValueOnce(new AppError("YOUTUBE_DAILY_QUOTA", "synthetic quota exhausted")); daily.runner.start(); await advance(); expect(await daily.runner.status()).toMatchObject({ state: "quota_wait", nextRetryAt: nextQuotaMidnight(Date.now()) });
    const rate = fixture(); vi.mocked(rate.ports.observe).mockRejectedValueOnce(new AppError("YOUTUBE_QUOTA", "synthetic temporary rate limit")); rate.runner.start(); await advance(); expect(await rate.runner.status()).toMatchObject({ state: "reconnecting", nextRetryAt: expect.any(Number) });
  });

  it("suspends the real observer path on YOUTUBE_DAILY_QUOTA until the next Los Angeles midnight", async () => {
    vi.setSystemTime(new Date("2026-03-08T09:59:00Z")); const f = fixture();
    vi.mocked(f.ports.observe).mockRejectedValueOnce(new AppError("YOUTUBE_DAILY_QUOTA", "synthetic broadcast query quota exhausted"));
    f.runner.start(); await advance(); const midnight = Date.parse("2026-03-09T07:00:00Z");
    expect(await f.runner.status()).toMatchObject({ state: "quota_wait", nextRetryAt: midnight }); expect(f.ports.observe).toHaveBeenCalledOnce(); expect(f.ports.stream).not.toHaveBeenCalled();
    await advance(60000); expect(f.ports.observe).toHaveBeenCalledOnce();
    vi.setSystemTime(midnight - 1000); await advance(500); expect(await f.runner.status()).toMatchObject({ state: "quota_wait", nextRetryAt: midnight }); expect(f.ports.observe).toHaveBeenCalledOnce();
    vi.setSystemTime(midnight + 1); await advance(); expect(f.ports.observe).toHaveBeenCalledTimes(2); expect(f.ports.stream).toHaveBeenCalledOnce(); expect((await f.runner.status()).state).toBe("connecting");
  });
});
