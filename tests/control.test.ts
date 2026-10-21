/** 使用模拟 OBS / YouTube 验证严格生命周期顺序、失败恢复及多实例并发。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Control } from "@/server/control";
import { Store } from "@/server/storage";
import { AppError, waitFor } from "@/server/errors";
import type { Broadcast, Stream, YouTubePort } from "@/server/youtube/api";
import type { ObsRuntime } from "@/server/obs/runtime";
import type { ControlState } from "@/shared/types";
import { makeProblem } from "@/shared/problems";
import { YouTubeApi } from "@/core/youtube/api";
import type { YouTubeAuth } from "@/core/youtube/auth";
import { installYouTubeRuntime, type YouTubeRuntime } from "@/core/youtube/usage";
import { youtubeCost } from "@/shared/youtube-usage";
import { hasPendingBroadcast } from "@/shared/broadcast-recovery";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const selection = { video: "study.mp4", music: "lofi.mp3", videoAudio: false };
/** 创建独立临时状态目录和可控制的上游模拟。 */
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-v2-test-")); dirs.push(dir);
  const storage = new Store(dir);
  const events: string[] = [];
  let streaming = false;
  let broadcast: Broadcast | null = null;
  let stream: Stream | null = null;
  let streamCount = 0;
  const obs: ObsRuntime = {
    status: vi.fn(async () => ({ ready: true, running: true, streaming })),
    ensureReady: vi.fn(async () => { events.push("ready"); }),
    validate: vi.fn(async () => { events.push("validate"); }),
    setMedia: vi.fn(async () => { events.push("media"); }),
    setStream: vi.fn(async () => { events.push("settings"); }),
    startStream: vi.fn(async () => { events.push("obs-start"); streaming = true; if (stream) stream.status.streamStatus = "active"; }),
    stopStream: vi.fn(async () => { events.push("obs-stop"); streaming = false; if (stream) stream.status.streamStatus = "inactive"; }),
  };
  const yt: YouTubePort = {
    channel: vi.fn(async () => ({ id: "channel", title: "My channel" })),
    broadcast: vi.fn(async () => { events.push("read-broadcast"); return broadcast ? structuredClone(broadcast) : null; }),
    stream: vi.fn(async () => stream ? structuredClone(stream) : null),
    createBroadcast: vi.fn(async title => { events.push("create"); broadcast = { id: "b1", snippet: { title }, status: { lifeCycleStatus: "ready" }, contentDetails: {} }; return structuredClone(broadcast); }),
    createStream: vi.fn(async title => { events.push("stream"); stream = { id: "s" + ++streamCount, snippet: { title }, status: { streamStatus: "inactive" }, cdn: { ingestionInfo: { streamName: "SECRET_STREAM_KEY", rtmpsIngestionAddress: "rtmps://example.test/live" } } }; return structuredClone(stream); }),
    findBroadcast: vi.fn(async () => broadcast ? structuredClone(broadcast) : null),
    findStream: vi.fn(async () => stream ? structuredClone(stream) : null),
    bind: vi.fn(async (_id, streamId) => { events.push("bind"); broadcast!.contentDetails = { boundStreamId: streamId }; }),
    transition: vi.fn(async (_, target) => { events.push(target); broadcast!.status.lifeCycleStatus = target; }),
  };
  const fastWait: typeof waitFor = async (read, accept, message) => {
    const value = await read();
    if (!accept(value)) throw new AppError("TIMEOUT", message);
    return value;
  };
  const media = vi.fn(async () => ({ video: "D:/media/videos/study.mp4", music: "D:/media/music/lofi.mp3" }));
  const control = new Control(obs, yt, storage, media, fastWait);
  return { control, storage, obs, yt, events, media, fastWait, setStreaming: (v: boolean) => { streaming = v; }, setLifecycle: (v: string) => { broadcast!.status.lifeCycleStatus = v; }, deleteStream: () => { stream = null; } };
}
describe("one-button lifecycle", () => {
  it("starts in order, confirms live, persists no stream key, stops OBS before platform cleanup", async () => {
    const f = await fixture();
    const live = await f.control.start(selection);
    expect(live.phase).toBe("live");
    expect(f.events.filter(e => e !== "read-broadcast")).toEqual(["ready", "validate", "media", "create", "stream", "bind", "settings", "obs-start", "live"]);
    expect(f.obs.setMedia).toHaveBeenCalledWith("D:/media/videos/study.mp4", "D:/media/music/lofi.mp3", false);
    expect(JSON.stringify(await f.storage.read("control.json"))).not.toContain("SECRET_STREAM_KEY");
    f.events.length = 0;
    expect((await f.control.stop()).phase).toBe("stopped");
    expect(f.events).toEqual(["obs-stop", "read-broadcast", "complete", "read-broadcast"]);
  });
  it("does nothing to OBS when YouTube is disconnected", async () => {
    const f = await fixture(); vi.mocked(f.yt.channel).mockRejectedValue(new AppError("AUTH", "connect"));
    await expect(f.control.start(selection)).rejects.toThrow("connect");
    expect(f.obs.ensureReady).not.toHaveBeenCalled();
  });
  it("rejects invalid media before launching OBS", async () => {
    const f = await fixture(); f.media.mockRejectedValue(new AppError("MEDIA", "invalid"));
    await expect(f.control.start(selection)).rejects.toThrow("invalid");
    expect(f.obs.ensureReady).not.toHaveBeenCalled();
  });
  it("stops after scene validation fails before creating a broadcast", async () => {
    const f = await fixture(); vi.mocked(f.obs.validate).mockRejectedValue(new AppError("SCENE", "missing"));
    await expect(f.control.start(selection)).rejects.toThrow("missing");
    expect(f.yt.createBroadcast).not.toHaveBeenCalled();
    expect(f.obs.startStream).not.toHaveBeenCalled();
  });
  it("does not touch a foreign existing OBS stream", async () => {
    const f = await fixture(); f.setStreaming(true);
    await expect(f.control.start(selection)).rejects.toThrow("不是本应用");
    expect(f.obs.setMedia).not.toHaveBeenCalled();
    expect(f.obs.stopStream).not.toHaveBeenCalled();
  });
  it("requires a read confirming binding before starting OBS", async () => {
    const f = await fixture(); vi.mocked(f.yt.bind).mockResolvedValue();
    await expect(f.control.start(selection)).rejects.toThrow("未确认绑定");
    expect(f.obs.startStream).not.toHaveBeenCalled();
  });
  it("never transitions live before ingest is active", async () => {
    const f = await fixture(); vi.mocked(f.obs.startStream).mockImplementation(async () => { f.setStreaming(true); });
    await expect(f.control.start(selection)).rejects.toThrow("未在时限内");
    expect(f.yt.transition).not.toHaveBeenCalled();
    expect((await f.control.state()).obsStartRequested).toBe(true);
  });
  it("does not report LIVE merely because transition returned success", async () => {
    const f = await fixture(); vi.mocked(f.yt.transition).mockResolvedValue();
    await expect(f.control.start(selection)).rejects.toThrow("结果未确认");
    expect((await f.control.state()).phase).toBe("error");
  });
  it("preserves and recovers a create that succeeded remotely but lost its response", async () => {
    const f = await fixture();
    const original = f.yt.createBroadcast;
    vi.mocked(f.yt.createBroadcast).mockImplementationOnce(async title => {
      // Use a separate resource so the API invocation itself is still counted once.
      const resource: Broadcast = { id: "recovered", snippet: { title }, status: { lifeCycleStatus: "ready" }, contentDetails: {} };
      vi.mocked(f.yt.findBroadcast).mockResolvedValue(resource);
      vi.mocked(f.yt.broadcast).mockImplementation(async () => resource);
      vi.mocked(f.yt.bind).mockImplementation(async () => { resource.contentDetails = { boundStreamId: "s1" }; });
      vi.mocked(f.yt.transition).mockImplementation(async (_, target) => { resource.status.lifeCycleStatus = target; });
      throw new AppError("NETWORK", "uncertain");
    });
    await expect(f.control.start(selection)).rejects.toThrow("uncertain");
    expect((await f.control.state()).broadcastIntent).toBe(true);
    expect((await f.control.start(selection)).phase).toBe("live");
    expect(original).toHaveBeenCalledTimes(1);
  });
  it("never blindly creates again when an ambiguous request cannot be found", async () => {
    const f = await fixture(); vi.mocked(f.yt.createBroadcast).mockRejectedValue(new AppError("NETWORK", "uncertain"));
    await expect(f.control.start(selection)).rejects.toThrow();
    await expect(f.control.start(selection)).rejects.toThrow("结果不确定");
    expect(f.yt.createBroadcast).toHaveBeenCalledTimes(1);
  });
  it("stops OBS when YouTube complete fails and supports platform-only retry", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.yt.transition).mockRejectedValueOnce(new Error("raw upstream SECRET_STREAM_KEY"));
    await expect(f.control.stop()).rejects.toThrow("YouTube Studio");
    expect(f.obs.stopStream).toHaveBeenCalledOnce();
    expect(await f.control.state()).toMatchObject({ platformClosePending: true, stopRequested: true, obsStartRequested: false });
    const queries = vi.mocked(f.yt.channel).mock.calls.length;
    await expect(f.control.start(selection)).rejects.toThrow("上一场仍待结束");
    expect(f.yt.channel).toHaveBeenCalledTimes(queries);
    expect(JSON.stringify(await f.control.state())).not.toContain("SECRET_STREAM_KEY");
    expect((await f.control.stop()).phase).toBe("stopped");
  });
  it("keeps platform pending after stopping OBS if complete confirmation fails", async () => {
    const f = await fixture(); await f.control.start(selection); vi.mocked(f.yt.transition).mockResolvedValue();
    await expect(f.control.stop()).rejects.toThrow("尚未确认结束");
    expect(f.obs.stopStream).toHaveBeenCalledOnce();
    expect((await f.control.state()).platformClosePending).toBe(true);
  });
  it("retries failed OBS stop before performing any platform cleanup", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.obs.stopStream).mockRejectedValueOnce(new AppError("OBS", "offline"));
    await expect(f.control.stop()).rejects.toThrow("offline");
    const count = vi.mocked(f.yt.transition).mock.calls.length;
    expect((await f.control.stop()).phase).toBe("stopped");
    expect(f.yt.transition).toHaveBeenCalledTimes(count + 1);
  });
  it("recovers after a server restart using disk state and does not duplicate live resources", async () => {
    const f = await fixture(); await f.control.start(selection);
    const restarted = new Control(f.obs, f.yt, f.storage, f.media, f.fastWait);
    expect((await restarted.start(selection)).phase).toBe("live");
    expect(f.yt.createBroadcast).toHaveBeenCalledTimes(1);
    expect(f.obs.startStream).toHaveBeenCalledTimes(1);
  });
  it("blocks a second in-process command until the first releases", async () => {
    const f = await fixture();
    let release!: () => void;
    const first = f.control.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(f.control.launch()).rejects.toThrow("正在执行");
    release(); await first;
    await f.control.launch();
  });
  it("enforces the lock across separate controllers", async () => {
    const f = await fixture(); const other = new Control(f.obs, f.yt, f.storage, f.media, f.fastWait);
    let release!: () => void;
    const first = f.control.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(other.launch()).rejects.toThrow("control.lock");
    release(); await first;
  });
  it("stops after user deletes an unstarted broadcast in Studio", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.yt.broadcast).mockResolvedValue(null);
    expect((await f.control.stop()).phase).toBe("stopped");
    expect(f.obs.stopStream).toHaveBeenCalledOnce();
  });
  it("does not claim Stopped when OBS status is unknown", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.obs.status).mockResolvedValue({ ready: false, running: true, streaming: null });
    await expect(f.control.stop()).rejects.toThrow("无法确认 OBS");
    expect((await f.control.state()).phase).toBe("error");
  });
  it("does not allow clearing a known pending broadcast", async () => {
    const f = await fixture(); await f.control.start(selection);
    await expect(f.control.clearUncertain()).rejects.toThrow("已有明确场次");
  });
  it("blocks channel mismatch and does not mutate the old broadcast", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.yt.channel).mockResolvedValue({ id: "other", title: "other" });
    await expect(f.control.stop()).rejects.toThrow("YouTube 场次尚未确认结束");
    expect(f.obs.stopStream).toHaveBeenCalledOnce();
  });
  it("reuses the stream for the next broadcast after a clean stop", async () => {
    const f = await fixture(); await f.control.start(selection); await f.control.stop();
    // YouTube observes ingest inactive once the encoder has stopped.
    const stream = await f.yt.stream("s1");
    vi.mocked(f.yt.stream).mockImplementation(async () => ({ ...stream!, status: { streamStatus: (await f.obs.status()).streaming ? "active" : "inactive" } }));
    expect((await f.control.start(selection)).phase).toBe("live");
    expect(f.yt.createStream).toHaveBeenCalledTimes(1);
    expect(f.yt.createBroadcast).toHaveBeenCalledTimes(2);
  });
  it("does not resume with different media after a failed create", async () => {
    const f = await fixture(); vi.mocked(f.yt.createBroadcast).mockRejectedValue(new AppError("NETWORK", "uncertain"));
    await expect(f.control.start(selection)).rejects.toThrow();
    await expect(f.control.start({ ...selection, videoAudio: true })).rejects.toThrow("保留原媒体");
  });
  /** 丢失推流对象只替换该引用；不得要求用户反复结束，也不额外创建待播广播。 */
  it("repairs an authoritatively deleted stream on the next broadcast", async () => {
    const f = await fixture(); await f.control.start(selection); await f.control.stop(); f.deleteStream();
    const next = { ...selection, video: "second.mp4", music: "second.mp3", videoAudio: true };
    expect((await f.control.start(next)).phase).toBe("live");
    expect((await f.control.state()).streamId).toBe("s2");
    expect(f.yt.createStream).toHaveBeenCalledTimes(2);
    expect(f.yt.createBroadcast).toHaveBeenCalledTimes(2);
    expect(f.yt.bind).toHaveBeenLastCalledWith("b1", "s2");
  });
  /** 读取暂时失败不是权威删除，不得替换原推流对象或重复创建场次。 */
  it("retains a known stream when its lookup fails temporarily", async () => {
    const f = await fixture(); await f.control.start(selection); await f.control.stop();
    vi.mocked(f.yt.stream).mockRejectedValueOnce(new AppError("NETWORK", "暂时无法查询"));
    await expect(f.control.start(selection)).rejects.toThrow("暂时无法查询");
    expect((await f.control.state()).streamId).toBe("s1"); expect(f.yt.createStream).toHaveBeenCalledTimes(1);
  });
  /** 新命令尚未产生副作用时，前置读取失败不能撤销前一场的已结束事实。 */
  it("preserves the completed session when the next channel preflight fails", async () => {
    const f = await fixture(); await f.control.start(selection); await f.control.stop();
    const old = await f.control.state(); vi.mocked(f.yt.channel).mockRejectedValueOnce(new AppError("NETWORK", "频道暂时不可读"));
    const next = { ...selection, video: "second.mp4" };
    await expect(f.control.start(next)).rejects.toThrow("频道暂时不可读");
    expect(await f.control.state()).toEqual(old);
    expect((await f.control.start(next)).selection?.video).toBe("second.mp4");
  });
  it("persisted errors retain the last real stage", async () => {
    const f = await fixture(); vi.mocked(f.obs.validate).mockRejectedValue(new Error("private raw error"));
    await expect(f.control.start(selection)).rejects.toThrow();
    const state = await f.storage.read<ControlState>("control.json");
    expect(state?.stage).toBe("校验 LIVE / VIDEO / MUSIC");
    expect(state?.error).not.toContain("private raw error");
  });
});

/** 三个控制器同时运行，验证等待、失败和停止只影响所属实例。 */
describe("independent local instances", () => {
  /** A 等待 OBS 时 B、C 可以开播；停止 B 不会停止 A 或 C。 */
  it("runs three instances concurrently and stops only the selected one", async () => {
    const [a, b, c] = await Promise.all([fixture(), fixture(), fixture()]);
    let release!: () => void;
    vi.mocked(a.obs.ensureReady).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const startingA = a.control.start(selection);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await Promise.all([b.control.start(selection), c.control.start({ ...selection, videoAudio: true })]);
    expect(a.control.busy).toBe(true);
    expect((await b.control.state()).phase).toBe("live");
    expect((await c.control.state()).selection?.videoAudio).toBe(true);
    release(); await startingA;
    await b.control.stop();
    expect(a.obs.stopStream).not.toHaveBeenCalled();
    expect(c.obs.stopStream).not.toHaveBeenCalled();
    expect((await a.control.state()).phase).toBe("live");
    expect((await c.control.state()).phase).toBe("live");
  });
  /** 一个频道 complete 失败时，另一个频道仍然可以正常结束。 */
  it("isolates a failed completion from another instance", async () => {
    const [a, b] = await Promise.all([fixture(), fixture()]);
    await Promise.all([a.control.start(selection), b.control.start(selection)]);
    vi.mocked(a.yt.transition).mockRejectedValueOnce(new Error("failure"));
    const results = await Promise.allSettled([a.control.stop(), b.control.stop()]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(a.obs.stopStream).toHaveBeenCalledOnce();
    expect((await b.control.state()).phase).toBe("stopped");
  });
});

/** 详情失败必须停止开播，重试只补齐已有场次。 */
it("applies frozen metadata before streaming and retries the same broadcast", async () => {
  const f = await fixture();
  const broadcast = { title: "东京雨夜", description: "晚间音乐", privacy: "public" as const, madeForKids: false, playlistIds: [] };
  f.yt.prepareBroadcast = vi.fn().mockRejectedValueOnce(new AppError("YOUTUBE_API", "封面权限不足")).mockResolvedValue(undefined);
  const input = { ...selection, broadcast };
  await expect(f.control.start(input)).rejects.toThrow("封面权限不足");
  expect(f.obs.startStream).not.toHaveBeenCalled();
  expect((await f.control.state()).broadcastId).toBe("b1");
  await expect(f.control.start({ ...input, broadcast: { ...broadcast, privacy: "private" } })).rejects.toThrow("直播详情");
  await f.control.start(input);
  expect(f.yt.createBroadcast).toHaveBeenCalledTimes(1);
  expect(f.yt.createBroadcast).toHaveBeenCalledWith(expect.stringContaining("LivePilot "), broadcast);
  expect(f.yt.prepareBroadcast).toHaveBeenLastCalledWith("b1", broadcast);
  expect((await f.control.state()).detailsApplied).toBe(true);
});


it("applies the authoritative chat config before OBS and refuses to start on config failure", async () => {
  const f = await fixture();
  const apply = vi.fn(async () => { f.events.push("chat-config"); });
  const control = new Control(f.obs, f.yt, f.storage, f.media, f.fastWait, apply);
  await control.start(selection);
  expect(apply).toHaveBeenCalledWith(selection); expect(f.events.indexOf("chat-config")).toBeLessThan(f.events.indexOf("ready"));
  const other = await fixture();
  const failed = new Control(other.obs, other.yt, other.storage, other.media, other.fastWait, async () => { throw new AppError("STORAGE", "synthetic config write failure"); });
  await expect(failed.start(selection)).rejects.toMatchObject({ code: "STORAGE" });
  expect(other.obs.ensureReady).not.toHaveBeenCalled(); expect(other.yt.createBroadcast).not.toHaveBeenCalled();
});

/** 配额或网络故障不能阻止用户先停止本机信号，仍须保留平台收尾保护。 */
it.each(["YOUTUBE_DAILY_QUOTA", "YOUTUBE_NETWORK"])("stops local OBS first on %s and blocks the next start", async code => {
  const f = await fixture(); await f.control.start(selection); f.events.length = 0;
  vi.mocked(f.yt.channel).mockRejectedValue(new AppError(code, "synthetic failure"));
  await expect(f.control.stop()).rejects.toMatchObject({ code });
  expect(f.events).toEqual(["obs-stop"]); expect(await f.control.state()).toMatchObject({ platformClosePending: true, stopRequested: true, obsStartRequested: false });
  await expect(f.control.start(selection)).rejects.toThrow("上一场仍待结束");
});
/** 应急停止通过同一控制器验证 OBS 归属，但不消耗任何 YouTube 调用。 */
it("local-only stop cancels chat before OBS and leaves platform pending with zero API requests", async () => {
  const f = await fixture(); await f.control.start(selection); vi.clearAllMocks(); f.events.length = 0;
  const stopped = vi.fn(async () => { f.events.push("chat-stop"); });
  const control = new Control(f.obs, f.yt, f.storage, f.media, f.fastWait, undefined, stopped);
  expect(await control.stop({ localOnly: true })).toMatchObject({ phase: "stopping", platformClosePending: true, obsStartRequested: false });
  expect(f.events).toEqual(["chat-stop", "obs-stop"]);
  for (const method of Object.values(f.yt)) expect(method).not.toHaveBeenCalled();
});
/** 外来推流与未知 OBS 状态均不能被标为已停止，也不触发平台结束。 */
it("keeps OBS_FOREIGN protection before platform or local stop", async () => {
  const f = await fixture(); f.setStreaming(true);
  await expect(f.control.stop({ localOnly: true })).rejects.toMatchObject({ code: "OBS_FOREIGN" });
  expect(f.obs.stopStream).not.toHaveBeenCalled(); expect(f.yt.channel).not.toHaveBeenCalled();
  expect((await f.control.state()).obsStoppedAt).toBeUndefined();
});
/** 聊天检查点故障不能让本机停止永久卡住。 */
it("still stops OBS if cancelling the chat checkpoint fails", async () => {
  const f = await fixture(); await f.control.start(selection);
  const control = new Control(f.obs, f.yt, f.storage, f.media, f.fastWait, undefined, async () => { throw new Error("synthetic disk error"); });
  await control.stop({ localOnly: true }); expect(f.obs.stopStream).toHaveBeenCalledOnce();
});
/** 平台准入尚未发出时也保留恢复时间，但整体操作已完成本机停止，属于部分完成。 */
it("retains safe retry metadata after local stop while describing the full operation as partial", async () => {
  const f = await fixture(); await f.control.start(selection); const retryAt = Date.now() + 60_000;
  vi.mocked(f.yt.channel).mockRejectedValue(new AppError("YOUTUBE_PROTECTION_WAIT", "synthetic safe wait", 429, makeProblem("YOUTUBE_PROTECTION_WAIT", "synthetic safe wait", { outcome: "not-sent", context: { retryAt } })));
  await expect(f.control.stop()).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_WAIT", problem: { outcome: "partial", context: { retryAt }, stage: "结束 YouTube 场次" } });
  expect(f.obs.stopStream).toHaveBeenCalledOnce(); expect(await f.control.state()).toMatchObject({ platformClosePending: true, obsStartRequested: false });
});

/** 运行真实创建API与准入，只替代平台HTTP；未发送意图可重试，已发出但未知的结果仍查重。 */
it.each(["broadcast", "stream"] as const)("reclaims only definitely unsent %s creation across budget, offline and dispatch denials", async kind => {
  const f = await fixture(), method = kind === "broadcast" ? "liveBroadcasts.insert" : "liveStreams.insert";
  const api = new YouTubeApi({ requestContext: { instanceId: "main" }, access: async () => ({ accessToken: "synthetic" }) } as unknown as YouTubeAuth, f.storage);
  const fetcher = vi.fn(async (url: string) => { expect(new URL(url).hostname).toBe("www.googleapis.com"); return Response.json({ id: "synthetic-created" }); }); vi.stubGlobal("fetch", fetcher);
  const original = kind === "broadcast" ? f.yt.createBroadcast : f.yt.createStream;
  if (kind === "broadcast") f.yt.createBroadcast = vi.fn(async title => { await api.createBroadcast(title); return original(title) as Promise<Broadcast>; });
  else f.yt.createStream = vi.fn(async title => { await api.createStream(title); return original(title) as Promise<Stream>; });
  /** 每个真实HTTP都需新准入，拒绝发生在request回调前；仅测试边界控制能否发送。 */
  const gate = (allowed: boolean, canSend = true): YouTubeRuntime => ({ async admit(input) { return { allowed, attemptId: input.attemptId, project: "synthetic", quotaDay: "2026-10-21", ...youtubeCost(input.method), remaining: 9000, backgroundRemaining: 2000, activeInstances: 1, resetAt: Date.now() + 86400_000, ...(allowed ? {} : { code: "YOUTUBE_BUDGET" }) }; }, canSend: () => canSend, async record() {} });
  try {
    for (const runtime of [gate(false), undefined, gate(true, false)]) {
      installYouTubeRuntime(runtime);
      await expect(f.control.start(selection)).rejects.toMatchObject({ problem: { outcome: "not-sent" } });
      const state = await f.control.state();
      expect(fetcher).not.toHaveBeenCalled(); expect(state[kind === "broadcast" ? "broadcastIntent" : "streamIntent"]).toBe(false);
      expect(state[kind === "broadcast" ? "broadcastTitle" : "streamTitle"]).toBeUndefined();
      expect(hasPendingBroadcast(state)).toBe(kind === "stream");
      if (kind === "stream") expect(state.broadcastId).toBe("b1");
    }
    installYouTubeRuntime(gate(true));
    expect((await f.control.start(selection)).phase).toBe("live");
    expect(fetcher).toHaveBeenCalledOnce(); expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toContain(method.split(".")[0]);
  } finally { installYouTubeRuntime(); vi.unstubAllGlobals(); }
});

/** 已经调用Google却未收到响应不能回收意图；恢复只查找原对象，绝不创建第二个。 */
it.each(["broadcast", "stream"] as const)("preserves an ambiguous %s create after a lost HTTP response", async kind => {
  const f = await fixture();
  const api = new YouTubeApi({ requestContext: { instanceId: "main" }, access: async () => ({ accessToken: "synthetic" }) } as unknown as YouTubeAuth, f.storage);
  const fetcher = vi.fn(async () => { throw new Error("synthetic lost response"); }); vi.stubGlobal("fetch", fetcher);
  if (kind === "broadcast") f.yt.createBroadcast = title => api.createBroadcast(title);
  else f.yt.createStream = title => api.createStream(title);
  try {
    await expect(f.control.start(selection)).rejects.toMatchObject({ code: "YOUTUBE_NETWORK" });
    expect((await f.control.state())[kind === "broadcast" ? "broadcastIntent" : "streamIntent"]).toBe(true);
    await expect(f.control.start(selection)).rejects.toMatchObject({ code: "UNCERTAIN" });
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
