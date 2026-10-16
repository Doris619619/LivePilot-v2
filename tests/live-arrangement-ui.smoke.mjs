/** 直播编排与账号 AI 的浏览器回归；真实隔离配置包，模拟账号 Key 保存和开播，绝不调用付费 AI。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:3021', output = 'docs/screenshots/live-arrangement';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message));
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await context.route('**/api/control', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 409, json: { error: '模拟验收：未实际开播。' } }); });
let status = { revision: 0, configured: false, managed: false, uses: { copy: true, chat: true } }, saved;
await context.route('**/api/account-ai', route => {
  if (route.request().method() === 'POST') { saved = route.request().postDataJSON(); status = { revision: status.revision + 1, configured: true, managed: true, uses: saved.uses }; }
  return route.fulfill({ json: status });
});
/** 等待浏览器完成布局，保存当前尺寸截图及溢出断言。 */
async function capture(name) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
}
try {
  await page.goto(origin + '/workspace');
  const first = page.locator('#instance-preview_liang-main');
  await expect(first.getByRole('tab', { name: '素材选择', exact: true })).toBeVisible();
  await expect(first.getByRole('heading', { name: 'AI 观众互动', exact: true })).toBeHidden();
  await first.locator('#video-preview_liang-main-primary').selectOption({ index: 1 });
  await first.locator('#music-preview_liang-main-primary').selectOption({ index: 1 });
  await first.getByRole('button', { name: '下一步：直播编排', exact: true }).click();
  await first.locator('#broadcast-title-preview_liang-main').fill('夜间电台 · Lofi');
  await first.locator('#chat-persona-preview_liang-main').selectOption('gentle');
  await first.locator('#chat-interval-preview_liang-main').selectOption('17');
  await first.locator('#chat-prompt-preview_liang-main').fill('温柔简短，跟随观众语言。');
  const complete = first.locator('.workflow-complete'); await complete.locator('summary').click();
  await expect(first.locator('#chat-interval-preview_liang-main-complete')).toHaveValue('17');
  await first.locator('#chat-persona-preview_liang-main-complete').selectOption('playful');
  await expect(first.locator('#chat-persona-preview_liang-main')).toHaveValue('playful');
  await complete.locator('summary').click();
  await capture('arrangement-desktop');
  await first.getByRole('button', { name: 'AI 服务设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tab', { name: 'AI 服务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('#api-settings-target')).toHaveCount(0);
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic_browser_only_key');
  await dialog.getByLabel('文案生成').uncheck();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');
  assert.deepEqual(saved.uses, { copy: false, chat: true });
  await expect(dialog.locator('#service-api-key')).toHaveValue('');
  await capture('account-ai-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('account-ai-mobile');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await capture('arrangement-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await first.getByRole('button', { name: '下一步：开播', exact: true }).click();
  await first.getByRole('button', { name: '开始直播', exact: true }).click();
  await expect(first.getByRole('alert').first()).toContainText('模拟验收');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].broadcast.liveChat, { enabled: true, preset: 'playful', customPrompt: '温柔简短，跟随观众语言。', intervalSeconds: 17 });
  assert.deepEqual(errors, []);
  console.log('PASS: shared chat fields, authoritative start payload, account key use switches, secret clearing, desktop/mobile layout. No real AI or broadcast.');
} finally { await browser.close(); }
