/** 文件用途：覆盖场次快照与草稿边界、晚到推流的显式恢复及中断 OBS 启动的可执行下一步。 */
import { expect, it } from "vitest";
import type { Dashboard } from "@/shared/types";
import { canResumeBroadcast, hasPendingBroadcast } from "@/shared/broadcast-recovery";
import { runtimeActionMode } from "@/app/components/broadcast-runtime-model";

const base: Dashboard = { busy: false, state: { phase: "error", stage: "等待信号", updatedAt: "", selection: { video: "first.mp4", music: "first.mp3", videoAudio: false } }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true, query: "ready" }, media: { videos: ["first.mp4"], music: ["first.mp3"] }, configuration: { missing: [], privacy: "private", madeForKids: false } };
const input = { stale: false, busy: false, live: false };

it("leaves errors before a broadcast identity editable but freezes actual pending sessions", () => {
  expect(hasPendingBroadcast(base.state)).toBe(false);
  for (const identity of [{ broadcastId: "known" }, { broadcastIntent: true }, { broadcastTitle: "pending" }]) expect(hasPendingBroadcast({ ...base.state, ...identity })).toBe(true);
  expect(hasPendingBroadcast({ ...base.state, phase: "stopped", broadcastId: "old" })).toBe(false);
});
it("offers an explicit resume when late ingest reached the existing ready broadcast", () => {
  const data: Dashboard = { ...base, state: { ...base.state, broadcastId: "known" }, obs: { ...base.obs, streaming: true }, youtube: { ...base.youtube, lifecycle: "ready", ingest: "active" } };
  expect(canResumeBroadcast(data)).toBe(true);
  expect(runtimeActionMode({ ...input, data })).toBe("resume");
  expect(runtimeActionMode({ ...input, stale: true, data })).toBe("check");
  expect(runtimeActionMode({ ...input, busy: true, data })).toBe("working");
  for (const lifecycle of ["live", "complete", "missing"]) expect(canResumeBroadcast({ ...data, youtube: { ...data.youtube, lifecycle } })).toBe(false);
  expect(canResumeBroadcast({ ...data, youtube: { ...data.youtube, query: "failed" } })).toBe(false);
  expect(canResumeBroadcast({ ...data, obs: { ...data.obs, streaming: null } })).toBe(false);
});
it("resumes an existing create intent without permitting a second in-flight command", () => {
  const data: Dashboard = { ...base, state: { ...base.state, broadcastIntent: true } };
  expect(runtimeActionMode({ ...input, data })).toBe("resume");
  for (const status of ["queued", "delivering", "accepted", "running", "uncertain"] as const) expect(canResumeBroadcast({ ...data, operation: { id: "old", action: "start", actor: "test", updatedAt: "", status } })).toBe(false);
});
it("lets a completed OBS launch be explicitly confirmed after a process interruption", () => {
  const data: Dashboard = { ...base, state: { phase: "idle", stage: "等待", updatedAt: "" }, operation: { id: "old", action: "launch", actor: "test", updatedAt: "", status: "interrupted" } };
  expect(runtimeActionMode({ ...input, data })).toBe("confirm-obs");
  expect(runtimeActionMode({ ...input, data: { ...data, obs: { ...data.obs, streaming: true } } })).toBe("check");
});
it("keeps a stopped local stream in closing recovery even when cached platform readiness would permit resume", () => {
  const data: Dashboard = { ...base, state: { ...base.state, broadcastId: "known" }, youtube: { ...base.youtube, lifecycle: "ready" } };
  for (const closing of [{ platformClosePending: true }, { stopRequested: true }]) {
    const pending = { ...data, state: { ...data.state, ...closing } };
    expect(canResumeBroadcast(pending)).toBe(false);
    expect(runtimeActionMode({ ...input, data: pending })).toBe("check");
    expect(runtimeActionMode({ ...input, busy: true, data: pending })).toBe("working");
  }
});
