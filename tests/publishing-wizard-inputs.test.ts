/** 向导快照与阻塞回归：旧响应身份变化、旧配置确认、首次目录及请求期间表单冻结。 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PublishingPlan } from "@/shared/publishing";
import PublishingWizard from "@/app/publishing/publishing-wizard";
import { publishingInputKey, publishingPlanMatchesInputs, type PublishingWizardInputs } from "@/app/publishing/publishing-wizard-inputs";
import { fixtureJob } from "./publishing-fixtures";

/** 合成真实身份和完整有效包，只测试向导选择与渲染，不访问设备或 YouTube。 */
function sample() {
  const spec = fixtureJob(); spec.profile.privacy = "public"; spec.profile.scheduled = true;
  const batch = { id: "c".repeat(64), version: "d".repeat(64), name: "Batch", issues: [], packages: [{ id: "e".repeat(64), version: "f".repeat(64), batchName: "Batch", name: "001", sourceVideo: spec.asset, validationState: "valid" as const, issues: [] }] };
  const rule = { timezone: "UTC", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 };
  const target = { agentId: spec.profile.agentId, instanceId: spec.profile.instanceId, channelId: spec.profile.channelId, name: "这台电脑" };
  const plan: PublishingPlan = { id: spec.batchId, revision: 1, owner: "alice", actor: "alice", profile: spec.profile, batch, rule, items: [{ packageId: batch.packages[0].id, excluded: false, scheduleSource: "auto", publishAt: "2030-10-01T18:00:00.000Z" }], copies: [], skippedOccupied: 0, skipped: [], createdAt: 1 };
  const inputs: PublishingWizardInputs = { target, batch, profile: spec.profile, rule, excluded: [] };
  const props: ComponentProps<typeof PublishingWizard> = { username: "alice", target, root: "D:\\LiveNest\\Publishing", batches: [batch], profiles: [spec.profile], profileId: spec.profile.id, selectProfile: () => {}, plans: [], jobs: [], busy: false, accepted: true, scan: async () => {}, newProfile: () => {}, preview: async () => undefined, update: async () => undefined, reschedulePreview: async () => undefined, rescheduleConfirm: async () => undefined, confirm: async () => false, operate: async () => true, archive: async () => {}, viewOverview: () => {} };
  return { plan, inputs, props };
}
afterEach(() => vi.unstubAllGlobals());

it("matches the exact current material, target, profile revision, rule and exclusions", () => {
  const { plan, inputs } = sample(); expect(publishingPlanMatchesInputs(plan, inputs)).toBe(true);
  const changes: PublishingWizardInputs[] = [
    { ...inputs, target: { ...inputs.target, agentId: "other" } },
    { ...inputs, target: { ...inputs.target, channelId: "other" } },
    { ...inputs, target: { ...inputs.target, accountId: "11111111-1111-4111-8111-111111111111" } },
    { ...inputs, batch: { ...inputs.batch!, version: "a".repeat(64) } },
    { ...inputs, profile: { ...inputs.profile!, id: "11111111-1111-4111-8111-111111111111" } },
    { ...inputs, profile: { ...inputs.profile!, revision: 2 } },
    { ...inputs, rule: { ...inputs.rule, timezone: "Asia/Shanghai" } },
    { ...inputs, excluded: [plan.items[0].packageId] },
  ];
  for (const changed of changes) {
    expect(publishingPlanMatchesInputs(plan, changed)).toBe(false);
    expect(publishingInputKey(changed)).not.toBe(publishingInputKey(inputs));
  }
  expect(publishingPlanMatchesInputs({ ...plan, archivedAt: 2 }, inputs)).toBe(false);
});

it("keeps the same request identity after saving a new plan revision and normalizes exclusion order", () => {
  const { plan, inputs } = sample(); const saved = { ...plan, revision: 2 };
  expect(publishingPlanMatchesInputs(saved, inputs)).toBe(true);
  expect(publishingInputKey({ ...inputs, excluded: ["b", "a"] })).toBe(publishingInputKey({ ...inputs, excluded: ["a", "b"] }));
});

it("shows an absolute Inbox before detection without claiming the directory is empty", () => {
  const { props } = sample();
  const html = renderToStaticMarkup(createElement(PublishingWizard, { ...props, batches: [], scanned: false }));
  expect(html).toContain("D:\\LiveNest\\Publishing\\Inbox"); expect(html).toContain("复制路径");
  expect(html).toContain("设置 → 打开发布目录"); expect(html).not.toContain("没有批次");
  expect(html).not.toMatch(/<details[^>]+open=/);
});

it("blocks confirming profile A after the user has selected profile B", () => {
  const { plan, props } = sample(); const second = { ...plan.profile, id: "11111111-1111-4111-8111-111111111111", name: "Profile B" };
  const html = renderToStaticMarkup(createElement(PublishingWizard, { ...props, plans: [plan], profiles: [plan.profile, second], profileId: second.id }));
  expect(html).toContain("设置已变化，请重新生成排期。");
  expect(html).not.toContain("发布尚未开启"); expect(html).not.toContain("自动公开待验收");
});

it("disables configuration, timezone and weekly inputs while generating a plan", () => {
  const { props, inputs } = sample();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ newDraft: true, batchId: inputs.batch!.id, profileId: inputs.profile!.id, rule: inputs.rule, excluded: [], step: 2 }) });
  const html = renderToStaticMarkup(createElement(PublishingWizard, { ...props, busy: true }));
  expect(html).toMatch(/<select[^>]*disabled=""/);
  expect(html).toContain('<fieldset class="publishing-weekly" disabled="">');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-haspopup="listbox"/);
  expect(html).not.toContain("发布尚未开启"); expect(html).not.toContain("自动公开待验收");
});
