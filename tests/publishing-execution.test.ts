/** 执行概览验证用户看到的数量和结果：真实公开、当前修订、取消及缺失任务互不混淆。 */
import { expect, it } from "vitest";
import type { PublishingPlan, PublishingReport, VideoJob } from "@/shared/publishing";
import { executionCounts, executionMetrics } from "@/app/publishing/batch-execution-data";
import { fixtureJob } from "./publishing-fixtures";

/** 独立合成任务设置真实报告，不模拟任何上传或远端发布。 */
function job(state: PublishingReport["state"], privacy: VideoJob["spec"]["profile"]["privacy"] = "public"): VideoJob {
  const spec = fixtureJob(); spec.profile.privacy = privacy;
  return { spec, createdAt: 1, observed: { id: spec.id, revision: spec.revision, sequence: 1, state, offset: 0, total: spec.asset.size, updatedAt: 1 } };
}

it("separates published videos from scheduled videos and never describes either as processing", () => {
  const published = job("published"); const publicCompleted = job("completed"); publicCompleted.observed!.observedPrivacy = "public";
  const counts = executionCounts([published, publicCompleted, job("scheduled"), job("uploading")]);
  expect(counts).toMatchObject({ total: 4, published: 2, scheduled: 1, processing: 1, pending: 0 });
  expect(executionMetrics(counts, true)).toEqual([["待处理", 0], ["处理中", 1], ["已排期", 1], ["已公开", 2], ["异常", 0]]);
});

it("returns stale success and active reports to waiting while keeping an explicit current block visible", () => {
  const values = [job("scheduled"), job("published"), job("completed", "private"), job("uploading"), job("failed")];
  for (const value of values) value.spec.revision++;
  const blocked = job("scheduled"); blocked.spec.revision++; blocked.blockReason = "等待原频道授权";
  expect(executionCounts([...values, blocked])).toMatchObject({ total: 6, pending: 5, attention: 1, scheduled: 0, published: 0, completed: 0, processing: 0 });
});

it("keeps cancellation waiting until its current revision is confirmed and removes confirmed cancellation from inventory", () => {
  const cancelled = job("cancelled"); cancelled.spec.desired = "cancel";
  const pending = job("cancelled"); pending.spec.desired = "cancel"; pending.spec.revision++;
  const stillScheduled = job("scheduled"); stillScheduled.spec.desired = "cancel";
  expect(executionCounts([cancelled, pending, stillScheduled])).toMatchObject({ total: 3, cancelled: 1, pending: 2, cancelPending: 2, scheduled: 0 });
});

it("groups actual preparation and upload work without counting retry, pause or unconfirmed controls as active work", () => {
  const active = ["preparing_media", "generating_metadata", "uploading", "processing", "finalizing"].map(state => job(state as PublishingReport["state"]));
  const pausing = job("uploading"); pausing.spec.desired = "pause";
  const counts = executionCounts([...active, job("retry_wait"), job("paused"), pausing, job("needs_attention"), job("failed")]);
  expect(counts).toMatchObject({ total: 10, processing: 5, pending: 3, attention: 2 });
});

it("shows private and unlisted completion separately from private observations on a public task", () => {
  const counts = executionCounts([job("completed", "private"), job("completed", "unlisted"), job("completed"), job("published", "private")]);
  expect(counts).toMatchObject({ total: 4, completed: 2, published: 1, pending: 1 });
  expect(executionMetrics(counts, false)).toEqual([["待处理", 1], ["处理中", 0], ["已完成", 3], ["异常", 0]]);
});

it("keeps confirmed items without admitted jobs visible and excludes explicitly unpublished packages", () => {
  const value = job("scheduled");
  const plan = { items: [{ packageId: "a", excluded: false }, { packageId: "b", excluded: false }, { packageId: "c", excluded: false }, { packageId: "d", excluded: true }] } as PublishingPlan;
  expect(executionCounts([value], plan)).toMatchObject({ total: 3, scheduled: 1, pending: 2, cancelled: 0 });
});
