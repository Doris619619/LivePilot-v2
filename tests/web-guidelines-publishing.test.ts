/** 发布表单与有界清单回归：只渲染合成任务，不连接设备、OAuth 或 YouTube。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { publishingDate, publishingMonth, publishingPage, publishingTags, replaceWeeklyTimes } from "@/app/publishing/form-inputs";
import PublishingCalendar from "@/app/publishing/publishing-calendar";
import JobList from "@/app/publishing/job-list";
import PlanConfirm from "@/app/publishing/plan-confirm";
import UploadReview from "@/app/publishing/upload-review";
import type { PublishingPlan, PublishingPlanRule, VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";

const url = vi.hoisted(() => ({ planPage: undefined as number | undefined }));
vi.mock("@/app/use-url-state", async importOriginal => {
  const actual = await importOriginal<typeof import("@/app/use-url-state")>();
  return { ...actual, useUrlState: (...args: Parameters<typeof actual.useUrlState>) => args[0] === "publishing-plan-page" && url.planPage !== undefined ? [url.planPage, () => {}] : actual.useUrlState(...args) };
});

afterEach(() => { vi.restoreAllMocks(); url.planPage = undefined; });

it("parses completed tag text only at submission and ignores empty separators", () => {
  expect(publishingTags("music, relaxation, ")).toEqual(["music", "relaxation"]);
  expect(publishingTags("中文,with spaces,,")).toEqual(["中文", "with spaces"]);
});

it("keeps weekly time input positions stable when a value crosses another time", () => {
  const rule: PublishingPlanRule = { timezone: "UTC", startDate: "2030-10-23", preuploadDays: 28, weeklySlots: [{ weekday: 1, time: "18:00" }, { weekday: 1, time: "20:00" }, { weekday: 3, time: "12:00" }] };
  const changed = replaceWeeklyTimes(rule, 1, ["21:00", "20:00"]);
  expect(changed.weeklySlots.filter(slot => slot.weekday === 1).map(slot => slot.time)).toEqual(["21:00", "20:00"]);
  expect(changed.weeklySlots.filter(slot => slot.weekday === 3)).toEqual([{ weekday: 3, time: "12:00" }]);
  expect(rule.weeklySlots[0].time).toBe("18:00");
});

it("rejects invalid URL dates and clamps malformed page inputs", () => {
  expect(publishingMonth("2030-10")).toBe("2030-10");
  expect(() => publishingMonth("2030-13")).toThrow();
  expect(() => publishingDate("2030-02-30")).toThrow();
  expect(publishingDate("2032-02-29")).toBe("2032-02-29");
  expect(["-1", "1.5", "NaN", "Infinity"].map(publishingPage)).toEqual([0, 0, 0, 0]);
});

/** 每条合成任务在同一天排期，验证极端单日密度仍只生成一页任务节点。 */
function calendarJob(index: number): VideoJob {
  const spec = fixtureJob(); spec.profile.scheduled = true; spec.profile.privacy = "public"; spec.originalPublishAt = "2030-10-23T12:00:00.000Z"; spec.asset.filename = `synthetic-${index}.mp4`;
  return { spec, createdAt: 1, observed: { id: spec.id, revision: spec.revision, sequence: 1, state: "uploading", offset: index, total: 1000, updatedAt: 1 } };
}

it("renders only 25 agenda articles for a day with 100 scheduled videos", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-10-23T00:00:00.000Z"));
  const html = renderToStaticMarkup(createElement(PublishingCalendar, { jobs: Array.from({ length: 100 }, (_, index) => calendarJob(index)) }));
  expect(html.match(/<article/g)).toHaveLength(25);
  expect(html).toContain("1 / 4 页 · 100 条");
});

it("keeps closed repeat-record disclosures from mounting 10000 list items", () => {
  const repeats = Array.from({ length: 10000 }, (_, index) => ({ packageId: String(index), version: "synthetic", name: `repeat-${index}`, label: "已发布", jobIds: [String(index)] }));
  const html = renderToStaticMarkup(createElement(UploadReview, { blockers: [], repeats, busy: false, history: () => {} }));
  expect(html).not.toContain("<li"); expect(html).toContain("10000 个素材");
});

it("announces the upload stage outside closed details without repeated percentages or duplicate regions", () => {
  const html = renderToStaticMarkup(createElement(JobList, { jobs: [calendarJob(125)], busy: false, operate: async () => true }));
  expect(html).toMatch(/role="status" aria-live="polite" aria-atomic="true">synthetic-125.mp4：正在上传<\/span>/);
  expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  expect(html.indexOf('aria-live="polite"')).toBeLessThan(html.indexOf("<details"));
  expect(html).toContain("正在上传 · 12%");
});

/** 不公开计划使用真实清单组件，分别覆盖单页与多页的超大 URL 页码。 */
function privatePlan(count: number): PublishingPlan {
  const spec = fixtureJob();
  const packages = Array.from({ length: count }, (_, index) => ({ id: String(index).padStart(64, "0"), version: "a".repeat(64), name: `Package ${index + 1}`, batchName: "Synthetic batch", validationState: "valid" as const, issues: [], sourceVideo: spec.asset }));
  return { id: spec.batchId, revision: 1, owner: "alice", actor: "alice", createdAt: 1, profile: spec.profile, batch: { id: "b".repeat(64), version: "c".repeat(64), name: "Synthetic batch", packages, issues: [] }, items: packages.map(pkg => ({ packageId: pkg.id, excluded: false, scheduleSource: "auto" })), copies: [], rule: { timezone: "UTC", startDate: "2030-10-23", preuploadDays: 28, weeklySlots: [{ weekday: 1, time: "18:00" }] }, skipped: [], skippedOccupied: 0 };
}

it.each([1, 26])("renders the final populated page for a %i-item private plan with an out-of-range URL page", count => {
  url.planPage = 999;
  const html = renderToStaticMarkup(createElement(PlanConfirm, { plan: privatePlan(count), busy: false, replacements: [], update: async () => undefined, confirm: async () => {}, back: () => {}, viewHistory: () => {} }));
  expect(html.match(/class="publishing-plan-item"/g)).toHaveLength(1);
  expect(html).toContain(`Package ${count}`);
  if (count > 25) { expect(html).toContain("2 / 2 页 · 26 条"); expect(html).not.toContain("Package 25"); }
});
