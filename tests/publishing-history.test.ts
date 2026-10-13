/** 发布历史的真实数据边界：保留已观察终态，API文案过期有快照回退，筛选与排序覆盖整份数据。 */
import { expect, it } from "vitest";
import type { PublishingPlan, PublishingReport, VideoJob } from "@/shared/publishing";
import { filterHistory, historyOutcome, historyTime, publishingHistory } from "@/app/publishing/publishing-history-data";
import { fixtureJob } from "./publishing-fixtures";

/** 不访问真实 YouTube 的合成历史任务，允许单独构造旧修订及不同计划时间。 */
function job(state: PublishingReport["state"], time = 1): VideoJob {
  const spec = fixtureJob();
  return { spec, createdAt: 1, observed: { id: spec.id, revision: spec.revision, sequence: 1, state, offset: 0, total: spec.asset.size, updatedAt: time } };
}

/** 提供用户确认的文案和批次快照，验证元数据清理后仍能辨认内容。 */
function plan(value: VideoJob): PublishingPlan {
  const packageId = "a".repeat(64);
  value.spec.contentPackage = { id: packageId, batchName: "夜雨", name: "001", version: "b".repeat(64), sourceVideo: value.spec.asset, validationState: "valid", issues: [] };
  return { id: value.spec.batchId, revision: 1, owner: "alice", actor: "alice", profile: value.spec.profile, batch: { id: "c".repeat(64), version: "d".repeat(64), name: "夜雨", packages: [], issues: [] }, rule: { timezone: "UTC", startDate: "2026-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 }, items: [], copies: [{ packageId, title: "Rainy Night", description: "" }], skippedOccupied: 0, skipped: [], createdAt: 1, confirmedAt: 1 };
}

it("keeps observed terminal facts while a new instruction awaits confirmation, excluding work merely scheduled", () => {
  const published = job("published"); published.spec.revision++;
  expect(publishingHistory([], [published, job("completed"), job("cancelled"), job("failed"), job("scheduled"), job("needs_attention")], []).map(value => value.result).sort()).toEqual(["cancelled", "completed", "failed", "published"]);
});

it("uses observed titles before user snapshots and retains identifiable fallback after API cache deletion", () => {
  const value = job("published"); const snapshot = plan(value);
  value.observed!.metadata = { title: "Final AI title", description: "" };
  expect(publishingHistory([snapshot], [value], [])[0].title).toBe("Final AI title");
  delete value.observed!.metadata;
  expect(publishingHistory([snapshot], [value], [])[0]).toMatchObject({ title: "Rainy Night", batch: "夜雨" });
  value.spec.overrides.title = "Human override";
  expect(publishingHistory([snapshot], [value], [])[0].title).toBe("Human override");
  delete value.spec.overrides.title;
  expect(publishingHistory([], [value], [])[0].title).toBe("001");
});

it("does not relabel old channel history after the same device is rebound", () => {
  const value = job("published");
  expect(publishingHistory([], [value], [{ agentId: "pc", instanceId: "main", name: "电脑", channelId: "channel_new", channel: "新频道" }])[0].channel).toBe("channel_one");
  expect(publishingHistory([], [value], [{ agentId: "pc", instanceId: "main", name: "电脑", channelId: "channel_one", channel: "Rainy Night Radio" }])[0].channel).toBe("Rainy Night Radio");
});

it("distinguishes a deliberate repeat batch while retaining the old video history", () => {
  const old = job("published"); const original = plan(old); old.observed!.videoId = "old_video";
  const next = job("published"); const repeated = plan(next); repeated.republishJobIds = [old.spec.id]; next.observed!.videoId = "new_video";
  const rows = publishingHistory([original, repeated], [old, next], []);
  expect(rows.find(row => row.job.spec.id === old.spec.id)).toMatchObject({ batch: "夜雨", result: "published" });
  expect(rows.find(row => row.job.spec.id === next.spec.id)).toMatchObject({ batch: "夜雨 · 再次发布", result: "published" });
  expect(rows.map(row => row.job.observed!.videoId).sort()).toEqual(["new_video", "old_video"]);
});

it("sorts by latest stored record and filters all records before pagination without mutating source jobs", () => {
  const values = Array.from({ length: 100 }, (_, index) => { const value = job(index === 75 ? "failed" : "published", index + 1); value.spec.asset.filename = index === 75 ? "Target.mp4" : "video-" + index + ".mp4"; return value; });
  const rows = publishingHistory([], values, []);
  expect(rows[0].recordedAt).toBe(100);
  expect(filterHistory(rows, "target", "failed").map(row => row.title)).toEqual(["Target.mp4"]);
  expect(filterHistory(rows, " Synthetic ", "failed")).toHaveLength(1);
  expect(filterHistory(rows, "channel_ONE", "")).toHaveLength(100);
  expect(values[0].observed!.updatedAt).toBe(1);
});

it("marks the displayed timestamp as saved schedule data and formats it in the plan timezone", () => {
  const value = job("published", Date.parse("2026-10-03T10:00:00Z")); value.spec.originalPublishAt = "2026-10-01T00:00:00Z"; value.observed!.effectivePublishAt = "2026-10-02T10:00:00Z"; value.spec.profile.schedule.timezone = "Asia/Shanghai";
  const row = publishingHistory([], [value], [])[0];
  expect(row.plannedAt).toBe("2026-10-02T10:00:00Z");
  expect(historyTime(row.plannedAt, row.timezone)).toBe("2026/10/02 18:00");
  expect(row.recordedAt).not.toBe(Date.parse(row.plannedAt!));
});

it("states the completed batch removal independently from videos already public without rewriting the report", () => {
  const value = job("published"); value.spec.desired = "cancel"; value.observed!.message = "视频已公开，取消未应用。";
  const row = publishingHistory([], [value], [])[0];
  expect(historyOutcome(row, true)).toEqual({ summary: "批次已移除 · YouTube 视频保留", message: undefined });
  expect(historyOutcome(row, false)).toEqual({ summary: "视频已公开，保留在 YouTube", message: undefined });
  expect(value.observed!.message).toBe("视频已公开，取消未应用。");
});

it("does not describe cancelled private videos as public or confuse retained history with a pending removal", () => {
  const value = job("cancelled"); value.spec.desired = "cancel";
  const row = publishingHistory([], [value], [])[0];
  expect(historyOutcome(row, true)).toEqual({ summary: "批次已移除", message: undefined });
  expect(historyOutcome(row, false)).toEqual({ summary: undefined, message: undefined });
});

it("keeps other failures and unconfirmed schedule messages even when a published batch has been removed", () => {
  const value = job("published"); value.spec.desired = "cancel";
  const row = publishingHistory([], [value], [])[0];
  value.observed!.message = "视频已公开；此前改期结果未确认。";
  expect(historyOutcome(row, true).message).toBe("视频已公开；此前改期结果未确认。");
  value.observed!.message = "授权已撤销，无法核对远端结果。";
  expect(historyOutcome(row, false).message).toBe("授权已撤销，无法核对远端结果。");
  value.blockReason = "设备账号已变更，请重新核对。";
  expect(historyOutcome(row, true).message).toBe("设备账号已变更，请重新核对。");
});

it("does not suppress a cancellation warning if the last confirmed result is not public", () => {
  const value = job("failed"); value.spec.desired = "cancel"; value.observed!.message = "视频已公开，取消未应用。";
  expect(historyOutcome(publishingHistory([], [value], [])[0], false)).toEqual({ summary: undefined, message: "视频已公开，取消未应用。" });
});
