/** 用户时间语义回归：总览和日历跟随当前改期，候选排期不冒充确认，历史保留记录而不伪造生效证据。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import PublishingCalendar from "@/app/publishing/publishing-calendar";
import { HistoryDetail } from "@/app/publishing/publishing-history";
import { publishingHistory } from "@/app/publishing/publishing-history-data";
import { nextPublication } from "@/app/publishing/publishing-overview";
import { confirmedJobPublishAt, jobScheduleNotice } from "@/app/publishing/display";
import { jobCalendarPublishAt, jobDisplayPublishAt } from "@/app/publishing/publishing-time";
import type { PublishingReport, VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";

const requested = "2030-10-07T20:00:00.000Z";
const previous = "2030-10-06T16:00:00.000Z";
const candidate = "2030-10-08T22:15:00.000Z";

/** 同一合成任务可复现修订接收与远端回读之间的窗口，不执行真实 API。 */
function job(state: PublishingReport["state"] = "scheduled"): VideoJob {
  const spec = fixtureJob(); spec.revision = 2; spec.profile.privacy = "public"; spec.profile.scheduled = true; spec.originalPublishAt = requested;
  spec.plan = { timezone: "America/New_York", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 };
  return { spec, initialPublishAt: previous, createdAt: 1, observed: { id: spec.id, revision: 2, sequence: 2, state, offset: spec.asset.size, total: spec.asset.size, updatedAt: 2, videoId: "synthetic_video", observedPrivacy: "private", remoteCheckedAt: 2, effectivePublishAt: requested } };
}

/** 固定“今天”只确定日历首屏，排期位置和时间来自真实组件与任务数据。 */
function calendar(values: VideoJob[]) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-07T14:00:00Z"));
  return renderToStaticMarkup(createElement(PublishingCalendar, { jobs: values }));
}

it("moves an unconfirmed reschedule to the user's new date in both overview and calendar", () => {
  const value = job(); value.observed!.revision = 1; value.observed!.effectivePublishAt = previous; value.pendingPublishAt = previous;
  expect(nextPublication([value])).toEqual({ instant: requested, timezone: "America/New_York" });
  const html = calendar([value]);
  expect(html).toContain('aria-label="2030-10-06，0 个视频"');
  expect(html).toContain('aria-label="2030-10-07，1 个视频"');
  expect(html).toContain("<time>16:00</time>");
  expect(html).toContain("等待设备接收");
});

it.each(["finalizing", "needs_attention", "retry_wait", "processing", "paused", "failed"] as const)("keeps a %s candidate out of the next-publication time", state => {
  const value = job(state); value.observed!.effectivePublishAt = candidate;
  expect(nextPublication([value])).toEqual({ instant: requested, timezone: "America/New_York" });
  expect(jobDisplayPublishAt(value)).toBe(requested);
  if (state !== "failed") {
    const html = calendar([value]);
    expect(html).toContain('aria-label="2030-10-07，1 个视频"');
    expect(html).toContain('aria-label="2030-10-08，0 个视频"');
  }
});

it.each(["pause", "cancel"] as const)("does not call a just-received %s instruction a confirmed active schedule", desired => {
  const value = job(); value.spec.desired = desired; value.observed!.effectivePublishAt = previous; value.pendingPublishAt = previous;
  expect(confirmedJobPublishAt(value)).toBeUndefined();
  expect(jobScheduleNotice(value)).not.toBe("YouTube 已确认");
  expect(nextPublication([value])).toEqual({ instant: requested, timezone: "America/New_York" });
  const html = calendar([value]);
  expect(html).toContain('aria-label="2030-10-07，1 个视频"');
  expect(html).toContain(desired === "pause" ? "暂停待设备确认" : "取消待设备确认");
});

it("uses a confirmed remote time consistently while preserving the user's original requested time", () => {
  const value = job(); value.observed!.effectivePublishAt = candidate;
  expect(confirmedJobPublishAt(value)).toBe(candidate);
  expect(nextPublication([value])).toEqual({ instant: candidate, timezone: "America/New_York" });
  const html = calendar([value]);
  expect(html).toContain('aria-label="2030-10-07，0 个视频"');
  expect(html).toContain('aria-label="2030-10-08，1 个视频"');
  expect(value.spec.originalPublishAt).toBe(requested);
});

it.each(["private", "unlisted"] as const)("never presents a %s task as a confirmed public schedule", privacy => {
  const value = job(); value.spec.profile.privacy = privacy;
  expect(confirmedJobPublishAt(value)).toBeUndefined();
  expect(nextPublication([value])).toBeUndefined();
});

it("ignores an invalid candidate rather than crashing the calendar or advertising it as confirmed", () => {
  const value = job(); value.observed!.effectivePublishAt = "not-an-instant";
  expect(confirmedJobPublishAt(value)).toBeUndefined();
  expect(nextPublication([value])).toEqual({ instant: requested, timezone: "America/New_York" });
  expect(calendar([value])).toContain('aria-label="2030-10-07，1 个视频"');
});

it("orders the selected-day agenda by UTC instants rather than serialized timezone offsets", () => {
  const late = job("finalizing"); late.spec.asset.filename = "late.mp4";
  const early = job("finalizing"); early.spec.asset.filename = "early.mp4"; early.spec.originalPublishAt = "2030-10-07T14:00:00-04:00";
  const html = calendar([late, early]); const agenda = html.slice(html.indexOf('class="publishing-agenda"'));
  expect(agenda.indexOf("early.mp4")).toBeLessThan(agenda.indexOf("late.mp4"));
  expect(agenda).toContain("<time>14:00</time>"); expect(agenda).toContain("<time>16:00</time>");
});

it("retains a completed schedule record without claiming it was confirmed or the exact publication time", () => {
  const value = job("published"); value.observed!.observedPrivacy = "public"; value.observed!.effectivePublishAt = candidate;
  value.observed!.message = "视频已公开；此前改期结果未确认。";
  expect(confirmedJobPublishAt(value)).toBeUndefined(); expect(nextPublication([value])).toBeUndefined();
  expect(jobCalendarPublishAt(value)).toBe(candidate);
  const row = publishingHistory([], [value], [])[0];
  const html = renderToStaticMarkup(createElement(HistoryDetail, { row, busy: false, operate: async () => true }));
  expect(html).toContain("视频已公开；此前改期结果未确认。");
  expect(html).toContain("<dt>排期记录</dt>");
  expect(html).toContain("2030/10/08 18:15");
  expect(html).not.toContain("YouTube 确认排期"); expect(html).not.toContain("实际公开时间");
});

it("does not inherit a terminal record from an old revision in the active calendar", () => {
  const value = job("published"); value.observed!.revision = 1; value.observed!.effectivePublishAt = previous;
  expect(jobCalendarPublishAt(value)).toBe(requested);
  expect(calendar([value])).toContain('aria-label="2030-10-07，1 个视频"');
});
