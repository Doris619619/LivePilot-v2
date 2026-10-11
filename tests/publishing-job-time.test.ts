/** 改期时间回归：区分请求计划、候选时间与远端确认，并验证计划时区和夏令时边界。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import JobList, { jobTime } from "@/app/publishing/job-list";
import { confirmedJobPublishAt, inputUtc, jobScheduleNotice, jobTimezone, localInputTime } from "@/app/publishing/display";
import type { PublishingReport, VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";

const original = "2030-10-06T16:00:00.000Z";
const requested = "2030-10-07T20:00:00.000Z";
/** 独立合成报告可模拟已接收修订但尚未回读的窗口，不访问真实设备或 YouTube。 */
function job(state: PublishingReport["state"] = "scheduled"): VideoJob {
  const spec = fixtureJob(); spec.revision = 2; spec.profile.privacy = "public"; spec.profile.scheduled = true; spec.originalPublishAt = requested;
  spec.plan = { timezone: "America/New_York", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 };
  return { spec, initialPublishAt: original, createdAt: 1, observed: { id: spec.id, revision: 2, sequence: 2, state, offset: spec.asset.size, total: spec.asset.size, updatedAt: 2, videoId: "synthetic_video", observedPrivacy: "private", remoteCheckedAt: 2, effectivePublishAt: requested } };
}
/** 静态渲染检查用户可读时间和标签，不使用实现中的候选字段推断公开成功。 */
function render(value: VideoJob) { return renderToStaticMarkup(createElement(JobList, { jobs: [value], busy: false, operate: async () => true })); }

it("shows the requested plan instead of a previous YouTube schedule while the revision is pending", () => {
  const value = job(); value.observed!.revision = 1; value.observed!.effectivePublishAt = original; value.pendingPublishAt = original;
  const html = render(value);
  expect(html).toContain("当前计划 · " + jobTime(value));
  expect(html).toContain("改期待设备确认");
  expect(html).not.toContain("YouTube 已确认");
  expect(confirmedJobPublishAt(value)).toBeUndefined();
});

it.each(["finalizing", "needs_attention", "retry_wait", "processing", "paused", "published", "failed"] as const)("never labels a %s candidate as a confirmed schedule even at the current revision", state => {
  const value = job(state); value.observed!.effectivePublishAt = "2030-10-08T22:15:00.000Z";
  const html = render(value);
  expect(confirmedJobPublishAt(value)).toBeUndefined();
  expect(html).not.toContain("YouTube 已确认");
  expect(html).not.toContain(jobTime(value, true));
  expect(html).toContain("当前计划 · " + jobTime(value));
});

it.each(["videoId", "observedPrivacy", "remoteCheckedAt", "effectivePublishAt"] as const)("requires %s as part of a current scheduled readback", field => {
  const value = job(); delete value.observed![field];
  expect(confirmedJobPublishAt(value)).toBeUndefined();
  expect(render(value)).not.toContain("YouTube 已确认");
});

it("separates the requested plan from a confirmed time shifted by the Agent lead time", () => {
  const value = job(); value.observed!.effectivePublishAt = "2030-10-07T20:10:00.000Z";
  expect(confirmedJobPublishAt(value)).toBe(value.observed!.effectivePublishAt);
  const html = render(value);
  expect(html).toContain("当前计划 · " + jobTime(value));
  expect(html).toContain("YouTube 已确认时间 · " + jobTime(value, true));
});

it("keeps saved paused changes distinct from application and retains publication rejection feedback", () => {
  const paused = job("paused"); paused.spec.desired = "pause"; paused.pendingPublishAt = original;
  expect(jobScheduleNotice(paused)).toBe("改期已保存，继续后应用");
  const published = job("published"); published.observed!.observedPrivacy = "public"; published.observed!.effectivePublishAt = original; published.observed!.message = "视频已公开，改期未应用。";
  expect(render(published)).toContain("视频已公开，改期未应用。");
  expect(render(published)).not.toContain("YouTube 已确认");
});

it("uses the plan timezone for both display and conversion instead of the profile or browser timezone", () => {
  const value = job(); value.spec.profile.schedule.timezone = "Asia/Shanghai";
  expect(jobTimezone(value)).toBe("America/New_York");
  expect(localInputTime(requested, jobTimezone(value))).toBe("2030-10-07T16:00");
  expect(inputUtc("2030-10-07T16:00", jobTimezone(value))).toBe(requested);
  expect(jobTime(value)).toContain("2030/10/07 16:00");
  expect(jobTime(value)).toContain("America/New_York");
  delete value.spec.plan;
  expect(jobTimezone(value)).toBe("Asia/Shanghai");
});

it("rejects nonexistent daylight-saving wall time and picks the first occurrence of repeated time", () => {
  expect(() => inputUtc("2030-03-10T02:30", "America/New_York")).toThrow("这个时间不存在，请调整夏令时日期或时间。");
  expect(inputUtc("2030-11-03T01:30", "America/New_York")).toBe("2030-11-03T05:30:00.000Z");
});
