/** 单视频阶段回归：上传完成不等于排期、候选不等于确认、到时不等于公开，执行首屏保持分页。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import BatchExecution from "@/app/publishing/batch-execution";
import { jobProgress } from "@/app/publishing/job-progress";
import type { PublishingReport, VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";

/** 合成当前修订报告可逐项改变远端证据，不执行上传、公开或真实设备请求。 */
function job(state: PublishingReport["state"]): VideoJob {
  const spec = fixtureJob(); spec.profile.privacy = "public"; spec.profile.scheduled = true; spec.originalPublishAt = "2000-01-01T12:00:00.000Z";
  return { spec, createdAt: 1, observed: { id: spec.id, revision: 1, sequence: 1, state, offset: 0, total: spec.asset.size, updatedAt: 1 } };
}

it("keeps a 100 percent upload at the upload stage until a later processing report arrives", () => {
  const value = job("uploading"); value.observed!.offset = value.spec.asset.size;
  expect(jobProgress(value)).toMatchObject({ stage: 1, complete: false, text: "正在上传 · 100%" });
  value.observed!.state = "processing"; value.observed!.videoId = "synthetic";
  expect(jobProgress(value)).toMatchObject({ stage: 2, complete: false });
});

it("holds candidate finalization and an unverified schedule before waiting for publication", () => {
  const value = job("finalizing"); Object.assign(value.observed!, { videoId: "synthetic", effectivePublishAt: value.spec.originalPublishAt, observedPrivacy: "private", remoteCheckedAt: 1 });
  expect(jobProgress(value)).toMatchObject({ stage: 3, complete: false });
  value.observed!.state = "scheduled"; delete value.observed!.remoteCheckedAt;
  expect(jobProgress(value)).toMatchObject({ stage: 3, complete: false });
});

it("waits for YouTube publication after confirmed scheduling even when the scheduled time is in the past", () => {
  const value = job("scheduled"); Object.assign(value.observed!, { videoId: "synthetic", effectivePublishAt: value.spec.originalPublishAt, observedPrivacy: "private", remoteCheckedAt: 1 });
  expect(jobProgress(value)).toMatchObject({ stage: 4, complete: false, text: "等待 YouTube 公开" });
  value.observed!.state = "published"; value.observed!.observedPrivacy = "public";
  expect(jobProgress(value)).toMatchObject({ stage: 5, complete: true, text: "YouTube 已公开" });
});

it("does not complete publication from an old revision or a private completion on a public plan", () => {
  const value = job("published"); value.spec.revision++;
  expect(jobProgress(value)).toMatchObject({ complete: false, tone: "waiting" });
  value.observed!.revision = value.spec.revision; value.observed!.state = "completed"; value.observed!.observedPrivacy = "private";
  expect(jobProgress(value).complete).toBe(false);
});

it.each(["private", "unlisted"] as const)("ends a %s task with completion labels rather than publication", privacy => {
  const value = job("completed"); value.spec.profile.privacy = privacy; value.spec.profile.scheduled = false;
  const progress = jobProgress(value);
  expect(progress).toMatchObject({ complete: true, stage: 5, text: "YouTube 已完成" });
  expect(progress.labels).toEqual(["准备文件", "上传 YouTube", "YouTube 处理", "确认设置", "保存视频", "已完成"]);
});

it("places unknown schedule failure at confirmation and remote processing rejection at processing", () => {
  const value = job("needs_attention"); Object.assign(value.observed!, { videoId: "synthetic", effectivePublishAt: value.spec.originalPublishAt, processingStatus: "succeeded" });
  expect(jobProgress(value)).toMatchObject({ stage: 3, tone: "error", complete: false, text: "确认排期 · 需要处理" });
  value.observed!.state = "failed"; value.observed!.processingStatus = "failed";
  expect(jobProgress(value)).toMatchObject({ stage: 2, tone: "error", complete: false });
});

it("keeps paused changes and failed preparations visibly stopped at their evidence-backed stage", () => {
  const paused = job("paused"); paused.spec.desired = "pause"; paused.pendingPublishAt = "2000-01-01T10:00:00.000Z"; Object.assign(paused.observed!, { videoId: "synthetic", effectivePublishAt: paused.pendingPublishAt });
  expect(jobProgress(paused)).toMatchObject({ stage: 3, tone: "paused", complete: false });
  expect(jobProgress(job("needs_attention"))).toMatchObject({ stage: 0, tone: "error", complete: false });
});

it("shows the first 25 video stages by default while every operation group remains folded", () => {
  const values = Array.from({ length: 100 }, (_, index) => { const value = job("ready"); value.spec.asset.filename = String(index + 1).padStart(3, "0") + ".mp4"; return value; });
  const html = renderToStaticMarkup(createElement(BatchExecution, { jobs: values, busy: false, operate: async () => true }));
  expect(html.match(/aria-label="发布进度"/g)).toHaveLength(25);
  expect(html).toContain("001.mp4"); expect(html).toContain("025.mp4"); expect(html).not.toContain("026.mp4");
  expect(html).not.toContain("<summary>任务与操作</summary>");
  expect(html.match(/<summary>操作与详情<\/summary>/g)).toHaveLength(25);
  expect(html).not.toMatch(/<details[^>]+open=/);
});
