/** 用户换批次和刷新草稿的恢复边界：本地选择不被旧计划吞掉，缓存不能证明素材已经可上传。 */
import { expect, it } from "vitest";
import type { PublishingPlan } from "@/shared/publishing";
import { hasNewPublishingDraft, parsePublishingDraft, restorePublishingPlan } from "@/app/publishing/publishing-wizard-draft";
import { fixtureJob } from "./publishing-fixtures";

const target = { agentId: "pc", instanceId: "main", accountId: "11111111-1111-4111-8111-111111111111" };

/** 草稿样本只提供恢复决策需要的固定身份和时间，不生成任何上传任务。 */
function plan(createdAt: number): PublishingPlan {
  const spec = fixtureJob(); spec.profile.accountId = target.accountId;
  return { id: spec.batchId, revision: 1, owner: "alice", actor: "alice", profile: spec.profile, batch: { id: "a".repeat(64), version: "b".repeat(64), name: "Old Batch", packages: [], issues: [] }, rule: { timezone: "UTC", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 }, items: [], copies: [], skippedOccupied: 0, skipped: [], createdAt };
}

it("preserves a newly selected batch before preview instead of reopening the old Cloud draft", () => {
  const old = plan(1); const cached = parsePublishingDraft({ newDraft: true, batchId: "c".repeat(64), rule: { ...old.rule, timezone: "Asia/Shanghai" }, excluded: ["d".repeat(64)], step: 2 });
  expect(restorePublishingPlan([old], target, cached)).toBeUndefined(); expect(cached).toMatchObject({ batchId: "c".repeat(64), rule: { timezone: "Asia/Shanghai" }, excluded: ["d".repeat(64)], step: 2 }); expect(old.confirmedAt).toBeUndefined();
});

it("keeps an explicit next-batch draft even before a directory scan has supplied a batch ID", () => {
  const old = plan(1); const cached = parsePublishingDraft({ newDraft: true, batchId: "", step: 1 });
  expect(hasNewPublishingDraft(cached)).toBe(true); expect(restorePublishingPlan([old], target, cached)).toBeUndefined();
});

it("supports previously saved local batch selections without the new marker", () => {
  const cached = parsePublishingDraft({ batchId: "c".repeat(64), step: 1 });
  expect(hasNewPublishingDraft(cached)).toBe(true); expect(restorePublishingPlan([plan(1)], target, cached)).toBeUndefined();
});

it("restores the exact cached confirmed plan rather than another unconfirmed plan", () => {
  const saved = plan(1); saved.confirmedAt = 2; const newer = plan(3); const cached = parsePublishingDraft({ planId: saved.id, batchId: saved.batch.id, step: 4 });
  expect(restorePublishingPlan([saved, newer], target, cached)).toBe(saved); expect(hasNewPublishingDraft(cached)).toBe(false);
});

it("restores the newest unfinished Cloud plan on a first visit and never imports another account or archived plan", () => {
  const older = plan(1); const latest = plan(2); const foreign = plan(10); foreign.profile.accountId = "22222222-2222-4222-8222-222222222222"; const archived = plan(20); archived.archivedAt = 21;
  expect(restorePublishingPlan([older, latest, foreign, archived], target)).toBe(latest);
  expect(restorePublishingPlan([older, foreign], target, parsePublishingDraft({ planId: foreign.id }))).toBe(older);
});

it("rejects invalid local rules and exclusion IDs rather than treating stored inputs as valid media", () => {
  const cached = parsePublishingDraft({ newDraft: true, batchId: "c".repeat(64), rule: { timezone: "not/a/timezone" }, excluded: ["../../file", 1, "d".repeat(64)], step: 100 });
  expect(cached).toMatchObject({ rule: undefined, excluded: ["d".repeat(64)], step: 1 }); expect(parsePublishingDraft([])).toBeUndefined();
});

it("does not restore a removed batch but keeps a pending deletion available for its progress", () => {
  const saved = plan(1); saved.confirmedAt = 2; const cached = parsePublishingDraft({ planId: saved.id, step: 4 });
  expect(restorePublishingPlan([saved], target, cached, [{ batchId: saved.id, requestedAt: 3 }])).toBe(saved);
  expect(restorePublishingPlan([saved], target, cached, [{ batchId: saved.id, requestedAt: 3, completedAt: 4 }])).toBeUndefined();
});
