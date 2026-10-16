/** 客户诊断移除与异常恢复验收；隔离预览状态和控制请求，不访问真实 OBS/YouTube。 */
import { chromium, expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
const origin = process.env.LIVEPILOT_UI_ORIGIN || 'http://127.0.0.1:3021';
const output = 'docs/screenshots/customer-recovery';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], commands = [];
let scenario = 'normal', reads = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await context.route('**/api/control', route => { commands.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { ok: true } }); });
await context.route('**/api/status?*', async route => {
  const response = await route.fetch();
  if (!response.ok() || new URL(route.request().url()).searchParams.get('instanceId') !== 'main') return route.fulfill({ response });
  reads++;
  const data = await response.json();
  if (scenario === 'obs') { data.obs.ready = false; data.obs.message = 'OBS 控制连接暂不可用，请检查直播电脑。'; delete data.obs.problem; }
  if (scenario === 'config') data.configuration.missing = ['MAIN_OBS_WS_PASSWORD'];
  if (scenario === 'youtube') { data.youtube.error = '暂时无法读取频道，请检查直播电脑的网络。'; delete data.youtube.problem; }
  if (scenario === 'auth') data.youtube.problem = { version: 1, source: 'agent', code: 'YOUTUBE_AUTH', domain: 'youtube', target: { instanceId: 'main' }, severity: 'error', stage: '读取频道', outcome: 'rejected', observedAt: Date.now(), message: '频道授权已失效。', actions: ['authorize', 'help'] };
  if (['uncertain', 'offline'].includes(scenario)) { data.state.broadcastIntent = true; delete data.state.broadcastId; }
  if (scenario === 'offline') data.device = { ...data.device, online: false };
  return route.fulfill({ response, json: data });
});
const card = page.locator('#instance-preview_liang-main');
/** 每种状态从真实预览快照派生，重载不提交控制请求。 */
async function load(value) {
  scenario = value;
  await page.goto(origin + '/workspace');
  await expect(card.getByRole('tab', { name: '素材选择', exact: true })).toBeVisible();
  await expect(card.getByText('连接与诊断', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Broadcast ID', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Stream ID', { exact: true })).toHaveCount(0);
}
try {
  await load('normal');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.locator('select').first()).toBeEnabled();
  await page.screenshot({ path: output + '/workspace-desktop.png', fullPage: true });
  await load('obs');
  await expect(card.getByText('OBS 控制连接暂不可用，请检查直播电脑。', { exact: true }).first()).toBeVisible();
  await card.getByRole('button', { name: '收起详情' }).click();
  await card.getByRole('button', { name: '查看设备与频道' }).click();
  await expect(card.locator('.studio-connections')).toHaveAttribute('open', '');
  await expect(card.locator('.studio-connections summary')).toBeFocused();
  await expect(card.locator('.instance-diagnostics')).toHaveCount(0);
  const before = reads;
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await page.screenshot({ path: output + '/connection-error.png', fullPage: true });
  await load('config');
  await expect(card.getByRole('alert').getByText(/OBS 控制密码/).first()).toBeVisible();
  await expect(card.getByRole('alert').getByText(/在对应直播电脑检查客户端/)).toBeVisible();
  await load('youtube');
  await expect(card.getByRole('alert').getByText('暂时无法读取频道，请检查直播电脑的网络。', { exact: true }).first()).toBeVisible();
  await expect(card.getByRole('button', { name: '重新检查', exact: true })).toBeEnabled();
  await load('auth');
  await expect(card.getByRole('button', { name: '重新授权原频道' })).toBeEnabled();
  await load('uncertain');
  const recovery = card.getByRole('alert', { name: '核对未确认场次' });
  await expect(recovery.getByRole('link', { name: '打开 YouTube Studio' })).toHaveAttribute('href', 'https://studio.youtube.com');
  await expect(recovery.getByRole('button', { name: '清理未确认状态' })).toBeDisabled();
  await recovery.getByLabel('已核对原频道没有此场次').check();
  await recovery.getByRole('button', { name: '清理未确认状态' }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ action: 'clear-uncertain', confirmed: true, instanceId: 'main', agentId: 'preview_liang' });
  await load('offline');
  await recovery.getByLabel('已核对原频道没有此场次').check();
  await expect(recovery.getByRole('button', { name: '清理未确认状态' })).toBeDisabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: output + '/recovery-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('PASS: diagnostics removed; connection/config/auth/channel recovery; confirmation and offline guards; 1440/390/320px. No real control or OAuth performed.');
} finally { await browser.close(); }
