/** 文件用途：在隔离真实网页中检查开播、继续、解锁与中断恢复入口，所有状态为合成数据且控制请求被拒绝。 */
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
let mode = 'idle', manualChecks = 0;
const output = process.env.RECOVERY_SCREENSHOTS || '.data/recovery-screenshots';
await mkdir(output, { recursive: true });
await page.route('**/api/control', route => route.fulfill({ status: 409, json: { error: '此验收不发送开播命令' } }));
await page.route('**/api/status?**', route => {
  const state = dashboard(agents[0], agents[0].instances[0]);
  state.configuration.youtubeRefresh = true;
  state.device = { agentId: agents[0].id, name: agents[0].name, online: true, lastSeen: Date.now(), observedAt: Date.now() };
  state.state.selection.broadcast = { title: '演示 · 夜晚电台', description: '合成数据，仅供布局验收。', privacy: 'public', madeForKids: false, playlistIds: [] };
  if (mode !== 'idle') {
    Object.assign(state.state, { broadcastTitle: '演示 · 夜晚电台', broadcastId: 'synthetic', phase: mode === 'failed' ? 'error' : mode === 'live' ? 'live' : 'starting', stage: mode === 'failed' ? '演示：连接推流服务失败，请重试。' : '正在确认推流状态' });
    state.youtube.lifecycle = 'ready';
  }
  if (mode === 'running') state.busy = true;
  if (mode === 'late') { state.obs.streaming = true; state.youtube.ingest = 'active'; }
  if (mode === 'ended') { state.state.phase = 'live'; state.youtube.lifecycle = 'complete'; }
  if (mode === 'intent') { delete state.state.broadcastId; state.state.broadcastIntent = true; state.state.phase = 'error'; }
  if (mode === 'unknown-read') { state.youtube.query = 'failed'; state.youtube.lifecycle = 'complete'; state.youtube.error = '演示：平台状态尚未确认'; }
  if (mode === 'launch-interrupted') { state.state = { phase: 'idle', stage: '等待', updatedAt: new Date().toISOString(), selection: state.state.selection }; state.operation = { id: 'synthetic', action: 'launch', status: 'interrupted', actor: '演示', updatedAt: new Date().toISOString() }; }
  if (mode === 'live') { state.obs.streaming = true; state.youtube.lifecycle = 'live'; state.youtube.ingest = 'active'; }
  if (mode === 'cached-live') {
    state.state.phase = 'live'; state.obs.streaming = true; state.youtube.lifecycle = 'live'; state.youtube.ingest = 'active';
    state.youtube.checkedAt = new Date(Date.now() - 30 * 60_000).toISOString(); state.youtube.nextCheckAt = new Date(Date.now() + 60 * 60_000).toISOString();
    if (route.request().method() === 'POST') { manualChecks++; state.youtube.lifecycle = 'complete'; state.youtube.checkedAt = new Date().toISOString(); }
  }
  return route.fulfill({ json: state });
});
try {
  for (const width of [390, 780, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (mode of ['idle', 'running', 'unknown', 'failed', 'live', 'late', 'ended', 'intent', 'unknown-read', 'launch-interrupted', 'cached-live']) {
      await page.goto(origin + '/workspace');
      const card = page.locator('#instance-preview_liang-main');
      await expect(card).toBeVisible();
      if (mode === 'idle' || mode === 'launch-interrupted') {
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
      await expect(launch.getByRole('button', { name: '继续本场开播', exact: true })).toHaveCount(['unknown', 'failed', 'late', 'intent'].includes(mode) ? 1 : 0);
      if (mode === 'running') await expect(launch.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled();
      if (mode === 'unknown-read') { await expect(launch.getByRole('button', { name: '重新检查状态', exact: true })).toBeVisible(); await expect(card.getByRole('button', { name: '解锁素材', exact: true })).toHaveCount(0); await expect(launch.getByRole('button', { name: '确认结束并解锁素材', exact: true })).toHaveCount(0); }
      if (mode === 'ended') { await expect(launch.getByText('本场已结束', { exact: true })).toBeVisible(); await expect(launch.getByRole('button', { name: '确认结束并解锁素材', exact: true })).toBeEnabled(); await expect(card.getByRole('button', { name: '解锁素材', exact: true })).toBeEnabled(); }
      if (mode === 'launch-interrupted') await expect(launch.getByRole('button', { name: '确认 OBS 已启动', exact: true })).toBeEnabled();
      if (mode === 'idle') await expect(launch.getByRole('button', { name: '开始直播', exact: true })).toBeEnabled();
      if (mode === 'live') await expect(launch.getByRole('button', { name: '结束直播', exact: true })).toBeEnabled();
      if (mode === 'cached-live') {
        await expect(launch.getByText('平台状态待核对', { exact: true })).toBeVisible();
        await expect(launch.getByText('上次：直播中', { exact: true })).toBeVisible();
        await expect(launch.getByText(/上次平台核对：.*30分钟前/)).toBeVisible();
        await launch.screenshot({ path: `${output}/${width}-cached-platform.png` });
        const previous = manualChecks;
        await launch.getByRole('button', { name: '重新检查状态', exact: true }).click();
        await expect(launch.getByText('上次：直播中', { exact: true })).toHaveCount(0);
        await expect(launch.getByText('已结束', { exact: true })).toBeVisible();
        assert.equal(manualChecks, previous + 1, 'one explicit POST requests fresh platform evidence');
      }
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
  console.log('Broadcast controls: 3 widths × 11 states and recovery passed (synthetic).');
} finally { await browser.close(); }
