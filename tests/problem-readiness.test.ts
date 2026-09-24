/** 准备状态的行为回归：辅助报告不阻塞，真实错误、未知结果与过期不能被隐藏。 */
import { expect, it } from "vitest";
import { makeProblem } from "@/shared/problems";
import { blocksStart, problemPresentation } from "@/shared/problem-policy";
import { startBlocker } from "@/shared/readiness";
import { obsReadiness } from "@/shared/obs-readiness";
import type { Dashboard } from "@/shared/types";
const dashboard: Dashboard = { busy: false, state: { phase: "idle", stage: "等待", updatedAt: "" }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true }, media: { videos: ["video.mp4"], music: ["music.mp3"] }, configuration: { missing: [], privacy: "private", madeForKids: false } };
const selection = { video: "video.mp4", music: "music.mp3", videoAudio: false };
it("does not let technical advice or update failures disable live controls", () => {
  const technical = makeProblem("FIREWALL_UNCONFIRMED", "技术检查");
  expect(problemPresentation(technical)).toBe("technical");
  expect(startBlocker({ ...dashboard, problems: [technical, makeProblem("UPDATE_INSTALL", "更新失败")], obs: { ...dashboard.obs, problem: technical } }, selection, false, false, false)).toBe("");
  expect(startBlocker(dashboard, { ...selection, music: "" }, false, false, false)).toContain("音乐");
});
it.each(["RESULT_SAVE", "SNAPSHOT_READ", "UNKNOWN", "OBS_AUTH", "YOUTUBE_AUTH"])("preserves blocking %s even after a technical advisory", code => {
  const problem = makeProblem(code, "真实待处理问题"); expect(blocksStart(problem)).toBe(true);
  expect(startBlocker({ ...dashboard, problems: [makeProblem("FIREWALL_UNCONFIRMED", "提示"), problem] }, selection, false, false, false)).toBe("真实待处理问题");
});
it("separates preparation and stale status by instance", () => {
  const now = Date.now(); const item = { id: "main", name: "OBS 1", managed: true, initialized: true, port: 4455, exe: "test" };
  const snapshot = { instance: { id: "main", name: "OBS 1" }, observedAt: now, dashboard };
  expect(obsReadiness(item, undefined, snapshot, now)).toMatchObject({ ready: true, label: "准备完成" });
  expect(obsReadiness({ ...item, id: "second" }, { id: "network-main", instanceId: "main", label: "OBS 1", status: "ready", checkedAt: now, controlReady: true }, snapshot, now)).toMatchObject({ ready: false, control: false, channel: false, media: false });
  expect(obsReadiness({ ...item, id: "second" }, undefined, { ...snapshot, dashboard: { ...dashboard, youtube: { connected: false } } }, now).channel).toBe(false);
  expect(obsReadiness(item, undefined, snapshot, now + 21_000)).toMatchObject({ ready: false, label: "待检查" });
  expect(blocksStart(makeProblem("CANCELLED", "停止等待，任务结果未确认", { outcome: "unknown" }))).toBe(true);
});
