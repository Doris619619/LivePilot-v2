/** 发布总览的统计边界：真实公开、修订确认、排期优先级与跨设备频道分组，不访问外部服务。 */
import { expect, it } from "vitest";
import type { PublishingPlan, PublishingReport, VideoJob } from "@/shared/publishing";
import { nextPublication, publicationBucket, publicationCounts, publishingOverview } from "@/app/publishing/publishing-overview";
import { jobStatus } from "@/app/publishing/display";
import { fixtureJob } from "./publishing-fixtures";

/** 合成普通视频任务，可独立设置公开方式和报告状态。 */
function job(state: PublishingReport["state"], privacy: VideoJob["spec"]["profile"]["privacy"] = "public"): VideoJob {
  const spec = fixtureJob(); spec.profile.privacy = privacy;
  return { spec, createdAt: 1, observed: { id: spec.id, revision: spec.revision, sequence: 1, state, offset: 0, total: spec.asset.size, updatedAt: 1 } };
}

/** 已确认 Plan 只提供统计所需的真实结构，内容与任务匹配仍靠批次 ID。 */
function plan(value: VideoJob, name = "Batch", count = 1): PublishingPlan {
  return { id: value.spec.batchId, revision: 1, owner: "alice", actor: "alice", profile: value.spec.profile, batch: { id: "a".repeat(64), version: "b".repeat(64), name, packages: [], issues: [] }, rule: { timezone: "UTC", startDate: "2026-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 }, items: Array.from({ length: count }, (_, index) => ({ packageId: index.toString(16).padStart(64, "0"), scheduleSource: "auto", excluded: false })), copies: [], skippedOccupied: 0, skipped: [], createdAt: 1, confirmedAt: 1 };
}

it("counts public completion only after a public observation and ignores old revision or merely scheduled reports", () => {
  const value = job("completed"); expect(publicationBucket(value)).toBe("pending");
  value.observed!.observedPrivacy = "private"; expect(publicationBucket(value)).toBe("pending");
  value.observed!.observedPrivacy = "public"; expect(publicationBucket(value)).toBe("published");
  value.spec.revision++; expect(publicationBucket(value)).toBe("pending");
  value.observed!.revision = value.spec.revision; value.observed!.state = "scheduled"; value.observed!.effectivePublishAt = "2026-01-01T00:00:00Z";
  expect(publicationBucket(value)).toBe("pending");
});

it("preserves durable published and non-public completion after API retention clears observation fields", () => {
  const published = job("published"); published.observed!.observedPrivacy = "public"; published.observed!.videoId = "published_video"; published.observed!.remoteCheckedAt = Date.parse("2026-01-01T00:00:00Z");
  const privateJob = job("completed", "private"); privateJob.observed!.observedPrivacy = "private"; privateJob.observed!.videoId = "private_video";
  for (const value of [published, privateJob]) { delete value.observed!.observedPrivacy; delete value.observed!.videoId; delete value.observed!.metadata; delete value.observed!.processingStatus; value.observed!.message = "YouTube 观察数据已超过保存期限，等待重新授权/核对。"; }
  expect(publicationCounts([published, privateJob])).toMatchObject({ published: 1, completed: 1, pending: 0 });
  const overview = publishingOverview([plan(published)], [published], [], Date.parse("2026-10-03T00:00:00Z"));
  expect(overview[0].batches[0]).toMatchObject({ state: "全部完成", counts: { published: 1, pending: 0 }, next: undefined });
});

it("keeps cancellation waiting until its current revision is acknowledged", () => {
  const value = job("cancelled"); value.spec.desired = "cancel"; value.spec.revision++;
  expect(publicationCounts([value])).toMatchObject({ pending: 1, cancelled: 0, cancelPending: 1 });
  value.observed!.revision = value.spec.revision;
  expect(publicationCounts([value])).toMatchObject({ pending: 0, cancelled: 1, cancelPending: 0 });
});

it("keeps pause pending until the current revision reports an actual paused state", () => {
  const value = job("paused"); value.spec.desired = "pause"; value.spec.revision++;
  expect(publicationCounts([value])).toMatchObject({ pending: 1, paused: 0, pausePending: 1 });
  expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0]).toMatchObject({ state: "暂停待确认", tone: "warning" });
  value.observed!.revision = value.spec.revision; value.observed!.state = "uploading";
  expect(publicationCounts([value])).toMatchObject({ pending: 1, paused: 0, pausePending: 1 });
  expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0].state).toBe("暂停待确认");
  value.observed!.state = "paused";
  expect(publicationCounts([value])).toMatchObject({ pending: 1, paused: 1, pausePending: 0 });
  expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0].state).toBe("本地已暂停");
  delete value.observed;
  expect(publicationCounts([value])).toMatchObject({ pending: 1, paused: 0, pausePending: 1 });
});

it("prioritizes actual attention and pending cancellation over an unconfirmed pause", () => {
  const pendingPause = job("ready"); pendingPause.spec.desired = "pause"; pendingPause.budgetWaiting = true;
  const attention = job("needs_attention"); attention.spec.batchId = pendingPause.spec.batchId;
  expect(publishingOverview([plan(pendingPause)], [pendingPause, attention], [], 0)[0].batches[0].state).toBe("需要处理");
  const pendingCancel = job("ready"); pendingCancel.spec.desired = "cancel"; pendingCancel.spec.batchId = pendingPause.spec.batchId;
  expect(publishingOverview([plan(pendingPause)], [pendingPause, pendingCancel], [], 0)[0].batches[0].state).toBe("取消待确认");
});

it("distinguishes non-public completion and blocked or failed work from waiting publication", () => {
  const privateJob = job("completed", "private"); const unlisted = job("completed", "unlisted"); const failed = job("failed"); const blocked = job("ready"); blocked.blockReason = "频道授权失效";
  expect(publicationCounts([privateJob, unlisted, failed, blocked, job("scheduled")])).toMatchObject({ total: 5, published: 0, completed: 2, pending: 1, attention: 2, scheduled: 1 });
});

it("keeps the exact legacy budget wait pending and labels it as automatic waiting instead of an error", () => {
  const value = job("ready"); delete value.observed;
  value.blockReason = "等待项目发布预算及太平洋时间配额日重置。";
  expect(publicationBucket(value)).toBe("pending");
  expect(publicationCounts([value])).toMatchObject({ pending: 1, attention: 0, budgetWaiting: 1 });
  expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0]).toMatchObject({ state: "等待预算/配额", tone: "warning" });
  expect(jobStatus(value)).toBe("等待预算");
  value.blockReason = "等待项目发布预算及太平洋时间配额日重置。请检查账号";
  expect(publicationBucket(value)).toBe("attention");
  expect(publicationCounts([value])).toMatchObject({ attention: 1, budgetWaiting: 0 });
});

it("uses the structured budget marker while keeping actual failures and remote terminal results authoritative", () => {
  const value = job("ready"); value.budgetWaiting = true; value.blockReason = "项目预算暂不可用";
  expect(publicationBucket(value)).toBe("pending"); expect(jobStatus(value)).toBe("等待预算");
  for (const state of ["failed", "needs_attention"] as const) {
    value.observed!.state = state;
    expect(publicationBucket(value)).toBe("attention");
    expect(publicationCounts([value])).toMatchObject({ attention: 1, budgetWaiting: 0 });
    expect(jobStatus(value)).toBe(state === "failed" ? "失败" : "需要处理");
    expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0].state).toBe("需要处理");
  }
  for (const state of ["published", "cancelled"] as const) {
    value.observed!.state = state;
    expect(publicationBucket(value)).toBe(state);
    expect(publicationCounts([value]).budgetWaiting).toBe(0);
    expect(jobStatus(value)).toBe(state === "published" ? "已公开" : "已取消");
  }
  value.spec.profile.privacy = "private"; value.observed!.state = "completed";
  expect(publicationBucket(value)).toBe("completed"); expect(jobStatus(value)).toBe("已完成");
});

it("keeps pending pause and cancellation ahead of the budget-wait badge and batch status", () => {
  const value = job("ready"); value.budgetWaiting = true; value.spec.revision++;
  for (const [desired, status, batchStatus] of [["pause", "暂停待设备确认", "暂停待确认"], ["cancel", "取消待设备确认", "取消待确认"]] as const) {
    value.spec.desired = desired;
    expect(jobStatus(value)).toBe(status);
    expect(publishingOverview([plan(value)], [value], [], 0)[0].batches[0].state).toBe(batchStatus);
    value.observed!.revision = value.spec.revision;
    expect(jobStatus(value)).toBe(status);
  }
});

it("excludes unpublished plan items while keeping missing admitted jobs and pauses in the remaining count", () => {
  const paused = job("paused"); paused.spec.desired = "pause"; const draft = plan(paused, "Batch", 4); draft.items[3].excluded = true;
  expect(publicationCounts([paused], draft)).toMatchObject({ total: 3, pending: 3, paused: 1, excluded: 1 });
});

it("uses effective time before original time and keeps overdue scheduled work for reconciliation", () => {
  const first = job("scheduled"); first.spec.originalPublishAt = "2026-10-08T00:00:00Z"; first.observed!.effectivePublishAt = "2026-10-02T00:00:00Z";
  const other = job("scheduled"); other.spec.originalPublishAt = "2026-10-04T00:00:00Z";
  const finished = job("published"); finished.observed!.observedPrivacy = "public"; finished.spec.originalPublishAt = "2026-10-01T00:00:00Z";
  expect(nextPublication([other, first, finished])).toEqual({ instant: first.observed!.effectivePublishAt, timezone: "UTC" });
  const groups = publishingOverview([plan(first)], [first], [], Date.parse("2026-10-03T00:00:00Z"));
  expect(groups[0].batches[0]).toMatchObject({ state: "等待公开确认", counts: { published: 0, pending: 1 } });
});

it("groups several devices and multiple batches per channel while retaining legacy batches", () => {
  const a = job("scheduled"); const b = job("scheduled"); const c = job("scheduled"); c.spec.profile.agentId = "pc_two"; c.spec.profile.channelId = "channel_two";
  const legacy = job("completed", "private"); const draft = plan(job("ready"), "Draft"); delete draft.confirmedAt;
  const groups = publishingOverview([plan(a, "Batch A"), plan(b, "Batch B"), plan(c, "Batch C"), draft], [a, b, c, legacy], [{ agentId: "pc", instanceId: "main", name: "电脑一", channelId: "channel_one", channel: "音乐频道" }, { agentId: "pc_two", instanceId: "main", name: "电脑二", channelId: "channel_two", channel: "教程频道" }], 0);
  expect(groups).toHaveLength(2);
  expect(groups.find(value => value.id === "channel_one")).toMatchObject({ name: "音乐频道", device: "电脑一", batches: [{ name: "Batch A" }, { name: "Batch B" }, { name: "视频任务 · Synthetic" }] });
  expect(groups.find(value => value.id === "channel_two")?.batches.map(value => value.name)).toEqual(["Batch C"]);
});

it("does not relabel an old batch with a newly bound channel on the same instance", () => {
  const value = job("scheduled");
  const groups = publishingOverview([plan(value)], [value], [{ agentId: "pc", instanceId: "main", name: "电脑", channelId: "channel_new", channel: "新账号" }], 0);
  expect(groups[0]).toMatchObject({ id: "channel_one", name: "channel_one" });
});
