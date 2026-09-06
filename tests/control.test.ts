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

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const selection = { video: "study.mp4", music: "lofi.mp3", videoAudio: false };
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-v2-test-")); dirs.push(dir);
  const storage = new Store(dir);
  const events: string[] = [];
  let streaming = false;
  let broadcast: Broadcast | null = null;
  let stream: Stream | null = null;
  const obs: ObsRuntime = {
    status: vi.fn(async () => ({ ready: true, running: true, streaming })),
    ensureReady: vi.fn(async () => { events.push("ready"); }),
    validate: vi.fn(async () => { events.push("validate"); }),
    setMedia: vi.fn(async () => { events.push("media"); }),
    setStream: vi.fn(async () => { events.push("settings"); }),
    startStream: vi.fn(async () => { events.push("obs-start"); streaming = true; if (stream) stream.status.streamStatus = "active"; }),
    stopStream: vi.fn(async () => { events.push("obs-stop"); streaming = false; }),
  };
  const yt: YouTubePort = {
    channel: vi.fn(async () => ({ id: "channel", title: "My channel" })),
    broadcast: vi.fn(async () => { events.push("read-broadcast"); return broadcast ? structuredClone(broadcast) : null; }),
    stream: vi.fn(async () => stream ? structuredClone(stream) : null),
    createBroadcast: vi.fn(async title => { events.push("create"); broadcast = { id: "b1", snippet: { title }, status: { lifeCycleStatus: "ready" }, contentDetails: {} }; return structuredClone(broadcast); }),
    createStream: vi.fn(async title => { events.push("stream"); stream = { id: "s1", snippet: { title }, status: { streamStatus: "inactive" }, cdn: { ingestionInfo: { streamName: "SECRET_STREAM_KEY", rtmpsIngestionAddress: "rtmps://example.test/live" } } }; return structuredClone(stream); }),
    findBroadcast: vi.fn(async () => broadcast ? structuredClone(broadcast) : null),
    findStream: vi.fn(async () => stream ? structuredClone(stream) : null),
    bind: vi.fn(async () => { events.push("bind"); broadcast!.contentDetails = { boundStreamId: "s1" }; }),
    transition: vi.fn(async (_, target) => { events.push(target); broadcast!.status.lifeCycleStatus = target; }),
  };
  const fastWait: typeof waitFor = async (read, accept, message) => {
    const value = await read();
    if (!accept(value)) throw new AppError("TIMEOUT", message);
    return value;
  };
  const media = vi.fn(async () => ({ video: "D:/media/videos/study.mp4", music: "D:/media/music/lofi.mp3" }));
  const control = new Control(obs, yt, storage, media, fastWait);
  return { control, storage, obs, yt, events, media, fastWait, setStreaming: (v: boolean) => { streaming = v; }, setLifecycle: (v: string) => { broadcast!.status.lifeCycleStatus = v; } };
}
describe("one-button lifecycle", () => {
  it("starts in order, confirms live, persists no stream key, completes before stopping OBS", async () => {
    const f = await fixture();
    const live = await f.control.start(selection);
    expect(live.phase).toBe("live");
    expect(f.events.filter(e => e !== "read-broadcast")).toEqual(["ready", "validate", "media", "create", "stream", "bind", "settings", "obs-start", "live"]);
    expect(f.obs.setMedia).toHaveBeenCalledWith("D:/media/videos/study.mp4", "D:/media/music/lofi.mp3", false);
    expect(JSON.stringify(await f.storage.read("control.json"))).not.toContain("SECRET_STREAM_KEY");
    f.events.length = 0;
    expect((await f.control.stop()).phase).toBe("stopped");
    expect(f.events).toEqual(["read-broadcast", "complete", "read-broadcast", "obs-stop"]);
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
  it("keeps OBS streaming when YouTube complete fails and supports retry", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.yt.transition).mockRejectedValueOnce(new Error("raw upstream SECRET_STREAM_KEY"));
    await expect(f.control.stop()).rejects.toThrow("YouTube Studio");
    expect(f.obs.stopStream).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.control.state())).not.toContain("SECRET_STREAM_KEY");
    expect((await f.control.stop()).phase).toBe("stopped");
  });
  it("does not stop OBS before a complete read confirms the result", async () => {
    const f = await fixture(); await f.control.start(selection); vi.mocked(f.yt.transition).mockResolvedValue();
    await expect(f.control.stop()).rejects.toThrow("未确认 complete");
    expect(f.obs.stopStream).not.toHaveBeenCalled();
  });
  it("retries OBS stop after YouTube is complete without another transition", async () => {
    const f = await fixture(); await f.control.start(selection);
    vi.mocked(f.obs.stopStream).mockRejectedValueOnce(new AppError("OBS", "offline"));
    await expect(f.control.stop()).rejects.toThrow("offline");
    const count = vi.mocked(f.yt.transition).mock.calls.length;
    expect((await f.control.stop()).phase).toBe("stopped");
    expect(f.yt.transition).toHaveBeenCalledTimes(count);
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
    await expect(f.control.stop()).rejects.toThrow("原 YouTube Channel");
    expect(f.obs.stopStream).not.toHaveBeenCalled();
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
  it("persisted errors retain the last real stage", async () => {
    const f = await fixture(); vi.mocked(f.obs.validate).mockRejectedValue(new Error("private raw error"));
    await expect(f.control.start(selection)).rejects.toThrow();
    const state = await f.storage.read<ControlState>("control.json");
    expect(state?.stage).toBe("校验 LIVE / VIDEO / MUSIC");
    expect(state?.error).not.toContain("private raw error");
  });
});
