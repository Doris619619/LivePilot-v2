/** 文件用途：覆盖网页运行状态的矛盾信号、未知结果、计时与观看链接，避免把部分成功呈现为已确认直播。 */
import { expect, it } from "vitest";
import type { Dashboard } from "@/shared/types";
import { broadcastWatchUrl, runtimeActionMode, runtimeDuration, runtimeSummary } from "@/app/components/broadcast-runtime-model";

const idle: Dashboard = { busy: false, state: { phase: "idle", stage: "等待", updatedAt: "" }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "private", madeForKids: false } };
const conflict: Dashboard = { ...idle, state: { ...idle.state, phase: "error", stage: "直播中", broadcastId: "example-id", broadcastTitle: "本场", error: "请求超时" }, youtube: { connected: true, lifecycle: "live", ingest: "active" } };
const input = { stale: false, busy: false, live: false };

it("explains YouTube live with no OBS signal and requires a read-only check before retry", () => {
  expect(runtimeSummary({ ...input, data: conflict })).toMatchObject({ status: "error", label: "推流中断" });
  expect(runtimeSummary({ ...input, data: conflict }).message).toContain("OBS 未推流，YouTube 场次仍在直播");
  expect(runtimeActionMode({ ...input, data: conflict })).toBe("check");
  expect(runtimeDuration(conflict, false, 0)).toBe("—");
});
it("does not trust the internal live stage without external confirmation", () => {
  expect(runtimeSummary({ ...input, data: { ...conflict, state: { ...conflict.state, phase: "live", error: undefined }, youtube: { connected: true } } }).label).toBe("直播状态待核对");
});
it.each(["ready", "complete", undefined])("does not offer retry while OBS streams and YouTube is %s", lifecycle => {
  const data = { ...conflict, obs: { ...idle.obs, streaming: true }, youtube: { connected: true, lifecycle } };
  expect(runtimeActionMode({ ...input, data })).toBe("check");
  expect(runtimeSummary({ ...input, data }).label).toBe("直播信号待确认");
});
it("does not offer retry after a platform query failed for an existing session", () => {
  expect(runtimeActionMode({ ...input, data: { ...conflict, youtube: { connected: true, query: "failed" } } })).toBe("check");
});
it("permits retry after a known inactive failure and preserves busy/stop protection", () => {
  const data = { ...conflict, youtube: { connected: true, lifecycle: "ready" } };
  expect(runtimeActionMode({ ...input, data })).toBe("retry");
  expect(runtimeActionMode({ ...input, busy: true, data: conflict })).toBe("working");
  expect(runtimeSummary({ ...input, busy: true, working: "stop", data: conflict }).label).toBe("正在结束直播");
});
it("hides stale signal conclusions and clock even if the last snapshot was live", () => {
  expect(runtimeSummary({ ...input, stale: true, live: true, data: conflict }).label).toBe("状态待更新");
  expect(runtimeDuration({ ...conflict, obs: { ...idle.obs, streaming: true } }, true, 64000)).toBe("—");
});
it("distinguishes verified live, reconnecting, idle and ended states", () => {
  const data = { ...idle, obs: { ...idle.obs, streaming: true }, youtube: { connected: true, lifecycle: "live", ingest: "active" } };
  expect(runtimeSummary({ ...input, data, live: true }).label).toBe("直播中");
  expect(runtimeSummary({ ...input, data: { ...data, obs: { ...data.obs, reconnecting: true } }, live: true }).label).toBe("推流重连中");
  expect(runtimeSummary({ ...input, data: idle }).label).toBe("等待开播");
  expect(runtimeSummary({ ...input, data: { ...idle, state: { ...idle.state, phase: "stopped" } } }).label).toBe("本场已结束");
  expect(runtimeSummary(input).label).toBe("正在读取状态");
});
it("shows an actual OBS duration and rejects absent or invalid samples", () => {
  const data = { ...idle, obs: { ...idle.obs, streaming: true } };
  expect(runtimeDuration(data, false, 3661000)).toBe("01:01:01");
  expect(runtimeDuration(data, false, 0)).toBe("00:00:00");
  for (const value of [null, NaN, -1, Infinity]) expect(runtimeDuration(data, false, value)).toBe("—");
});
it("uses only the current broadcast ID for the watch URL, encoding it without a channel fallback", () => {
  expect(broadcastWatchUrl("abc-_123")).toBe("https://www.youtube.com/watch?v=abc-_123");
  expect(broadcastWatchUrl("a&b#c")).toBe("https://www.youtube.com/watch?v=a%26b%23c");
  expect(broadcastWatchUrl()).toBeUndefined();
  expect(broadcastWatchUrl(" ")).toBeUndefined();
});
