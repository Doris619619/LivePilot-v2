/** 验证本地发布示例遵守真实 DTO，且不允许演示入口提交真实发布或授权。 */
import { describe, expect, it } from 'vitest';
import { previewCookies } from '../scripts/preview/security.mjs';
import { createPublishingPreview } from '../scripts/preview/publishing.mjs';
import { profileSchema, packagesResultSchema, jobSpecSchema, publishingAccountSchema, publishingReportSchema } from '../src/shared/publishing';

describe('publishing UI preview', () => {
  it('uses valid public DTOs and a current-month draft', () => {
    const preview = createPublishingPreview();
    expect(profileSchema.safeParse(preview.view.profiles[0]).success).toBe(true);
    for (const account of preview.view.accounts) expect(publishingAccountSchema.safeParse(account).success).toBe(true);
    expect(preview.view.accounts.map(account => account.status)).toEqual(['connected', 'connected', 'unbound', 'needs_reauthorization', 'cleanup_pending']);
    expect(preview.view.accounts.every(account => account.agentId === 'preview_liang' && account.instanceId === 'main')).toBe(true);
    expect(preview.view.profiles[0].accountId).toBe(preview.view.accounts[0].id);
    expect(preview.view.profiles[0].channelId).toBe(preview.view.accounts[0].channelId);
    expect(preview.view.cleanups[0].accountId).toBe(preview.view.accounts[4].id);
    expect(packagesResultSchema.safeParse(preview.request({ action: 'packages' })).success).toBe(true);
    for (const job of preview.view.jobs) {
      expect(jobSpecSchema.safeParse(job.spec).success).toBe(true);
      expect(publishingReportSchema.safeParse(job.observed).success).toBe(true);
      expect(job.spec.profile.accountId).toBe(preview.view.accounts[0].id);
    }
  });
  it('creates only unbound synthetic accounts in the current preview and keeps authorization blocked', () => {
    const first = createPublishingPreview(); const second = createPublishingPreview();
    const created = first.request({ action: 'account-create', agentId: 'preview_liang', instanceId: 'main', name: '  新的合成账号  ', owner: 'outside' });
    expect(publishingAccountSchema.safeParse(created).success).toBe(true);
    expect(created).toMatchObject({ name: '新的合成账号', owner: 'Liang', status: 'unbound', agentId: 'preview_liang', instanceId: 'main' });
    expect(created.channelId).toBeUndefined(); expect(created.connectedAt).toBeUndefined();
    expect(first.view.accounts).toHaveLength(6); expect(second.view.accounts).toHaveLength(5);
    expect(first.view.accounts.find(account => account.id === created.id)).toEqual(created);
    const snapshot = structuredClone(first.view);
    for (const action of ['account-connect', 'account-cleanup']) expect(() => first.request({ action, accountId: created.id, confirmed: true })).toThrow('本地界面预览');
    expect(first.view).toEqual(snapshot);
  });
  it('rejects foreign targets and invalid names before creating any preview account', () => {
    const preview = createPublishingPreview();
    for (const fields of [{ agentId: 'outside' }, { instanceId: 'outside' }, { name: '' }, { name: ' ' }, { name: 'x'.repeat(81) }, { name: null }]) {
      expect(() => preview.request({ action: 'account-create', agentId: 'preview_liang', instanceId: 'main', name: '示例账号', ...fields })).toThrow('请选择示例电脑');
    }
    expect(preview.view.accounts).toHaveLength(5);
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
