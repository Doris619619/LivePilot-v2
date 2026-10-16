/** 运行在隔离本地预览上；合成场次覆盖开播、执行中、未知、失败和恢复，不发送真实命令。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { agents, dashboard } from '../scripts/preview/fixtures.mjs';

const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:3031';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Only isolated loopback preview is allowed');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let mode = 'idle';
const output = 'docs/screenshots/broadcast-controls';
await mkdir(output, { recursive: true });
await page.route('**/api/control', route => route.fulfill({ status: 409, json: { error: '此验收不发送开播命令' } }));
await page.route('**/api/status?**', route => {
  const state = dashboard(agents[0], agents[0].instances[0]);
  state.state.selection.broadcast = { title: '演示 · 夜晚电台', description: '合成数据，仅供布局验收。', privacy: 'public', madeForKids: false, playlistIds: [] };
  if (mode !== 'idle') {
    Object.assign(state.state, { broadcastTitle: '演示 · 夜晚电台', broadcastId: 'synthetic', phase: mode === 'failed' ? 'error' : mode === 'live' ? 'live' : 'starting', stage: mode === 'failed' ? '演示：连接推流服务失败，请重试。' : '正在确认推流状态' });
    state.youtube.lifecycle = 'ready';
  }
  if (mode === 'running') state.busy = true;
  if (mode === 'live') { state.obs.streaming = true; state.youtube.lifecycle = 'live'; state.youtube.ingest = 'active'; }
  return route.fulfill({ json: state });
});
try {
  for (const width of [390, 780, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (mode of ['idle', 'running', 'unknown', 'failed', 'live']) {
      await page.goto(origin + '/workspace');
      const card = page.locator('#instance-preview_liang-main');
      await expect(card).toBeVisible();
      if (mode === 'idle') {
        const expand = card.getByRole('button', { name: '展开详情', exact: true });
        if (await expand.isVisible()) await expand.click();
        await card.getByRole('tab', { name: /开播$/ }).click();
      } else {
        await card.getByRole('button', { name: '查看运行状态', exact: true }).click();
        await expect(card.getByRole('heading', { name: '本场运行状态', exact: true })).toBeFocused();
      }
      const launch = card.locator('.workflow-launch');
      await expect(launch).toBeVisible();
      await expect(card.locator('.compact-actions-col .btn-primary')).toHaveCount(0);
      await expect(launch.getByRole('button', { name: '重试开播', exact: true })).toHaveCount(mode === 'failed' ? 1 : 0);
      if (mode === 'running') await expect(launch.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled();
      if (mode === 'unknown') await expect(launch.getByRole('button', { name: '重新检查状态', exact: true })).toBeVisible();
      if (mode === 'idle') await expect(launch.getByRole('button', { name: '开始直播', exact: true })).toBeEnabled();
      if (mode === 'live') await expect(launch.getByRole('button', { name: '结束直播', exact: true })).toBeEnabled();
      const layout = await card.evaluate(el => {
        const launch = el.querySelector('.workflow-launch').getBoundingClientRect();
        const review = el.querySelector('.workflow-review').getBoundingClientRect();
        return { launchBottom: launch.bottom, reviewTop: review.top, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.ok(layout.launchBottom <= layout.reviewTop, 'controls precede the long review');
      assert.equal(layout.overflow, false, 'no horizontal overflow');
      await launch.screenshot({ path: `${output}/${width}-${mode}.png` });
      if (mode === 'failed') {
        mode = 'live';
        await page.reload();
        await card.getByRole('button', { name: '查看运行状态', exact: true }).click();
        await expect(launch.getByRole('button', { name: '重试开播', exact: true })).toHaveCount(0);
        await expect(launch.getByRole('button', { name: '结束直播', exact: true })).toBeEnabled();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Broadcast controls: 3 widths × 5 states and recovery passed (synthetic).');
} finally { await browser.close(); }
