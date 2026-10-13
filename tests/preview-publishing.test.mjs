/** 验证本地发布示例遵守真实 DTO，且不允许演示入口提交真实发布或授权。 */
import { describe, expect, it } from 'vitest';
import { previewCookies } from '../scripts/preview/security.mjs';
import { createPublishingPreview } from '../scripts/preview/publishing.mjs';
import { profileSchema, packagesResultSchema, jobSpecSchema, publishingAccountSchema, publishingReportSchema } from '../src/shared/publishing';

describe('publishing UI preview', () => {
  it('uses valid public DTOs and a current-month draft', () => {
    const preview = createPublishingPreview();
    expect(profileSchema.safeParse(preview.view.profiles[0]).success).toBe(true);
    expect(publishingAccountSchema.safeParse(preview.view.accounts[0]).success).toBe(true);
    expect(packagesResultSchema.safeParse(preview.request({ action: 'packages' })).success).toBe(true);
    for (const job of preview.view.jobs) {
      expect(jobSpecSchema.safeParse(job.spec).success).toBe(true);
      expect(publishingReportSchema.safeParse(job.observed).success).toBe(true);
    }
  });
  it('isolates edits per preview and rejects publish or authorization actions', () => {
    const first = createPublishingPreview(); const second = createPublishingPreview();
    const draft = first.view.plans.find(plan => !plan.confirmedAt);
    first.request({ action: 'plan-update', planId: draft.id, revision: draft.revision, items: [{ ...draft.items[0], title: '本地编辑' }] });
    expect(draft.items[0].title).toBe('本地编辑');
    expect(second.view.plans.at(-1).items[0].title).toBeUndefined();
    for (const action of ['plan-confirm', 'account-connect', 'account-cleanup', 'job', 'batch-remove']) expect(() => first.request({ action })).toThrow('本地界面预览');
  });
});

it('retains both remembered accounts and active session cookies without retaining revoked values', () => {
  const headers = new Headers(); headers.append('set-cookie', 'accounts=synthetic-list; HttpOnly'); headers.append('set-cookie', 'session=synthetic-active; HttpOnly');
  expect(previewCookies('', headers)).toBe('accounts=synthetic-list; session=synthetic-active');
  const cleared = new Headers(); cleared.append('set-cookie', 'session=; Max-Age=0');
  expect(previewCookies(previewCookies('', headers), cleared)).toBe('accounts=synthetic-list');
});
