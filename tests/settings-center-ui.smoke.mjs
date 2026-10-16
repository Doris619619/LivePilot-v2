/** 隔离预览中的设置中心回归：尺寸、滚动、草稿、关闭保护及桌面/手机；所有写请求均模拟。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:3021';
const output = 'docs/screenshots/settings-center';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], geometry = [];
page.on('pageerror', error => errors.push(error.message));
let failSave = true, writes = 0;
let status = { revision: 0, configured: false, managed: false, uses: { copy: true, chat: true } };
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin !== origin) return route.abort();
  if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 409, json: { error: '验收禁止真实写操作' } });
  return route.continue();
});
await context.route('**/api/account-ai', async route => {
  if (route.request().method() === 'POST') {
    writes++;
    await new Promise(resolve => setTimeout(resolve, 500));
    if (failSave) return route.fulfill({ status: 409, json: { error: '测试保存失败，请重试。' } });
    status = { ...status, configured: true, managed: true, revision: 1, uses: route.request().postDataJSON().uses };
  } else await new Promise(resolve => setTimeout(resolve, 300));
  return route.fulfill({ json: status });
});
const dialog = page.getByRole('dialog');
/** 比较稳定外框；禁止把长表单变成弹窗整体滚动或横向溢出。 */
async function measure(label) {
  await dialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  const box = await dialog.boundingBox();
  geometry.push({ label, ...box });
  assert(await dialog.evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'outer dialog must not scroll');
  assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'dialog horizontal overflow');
  return box;
}
/** 保存可审阅的视口截图，避开未保存的合成密钥。 */
async function capture(name) { await page.screenshot({ path: `${output}/${name}.png` }); }
try {
  await page.goto(origin + '/workspace');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(dialog).toBeVisible();
  const initial = await measure('desktop-loading');
  const key = dialog.locator('#service-api-key');
  await expect(key).toBeEnabled();
  assert.deepEqual(await measure('desktop-ai'), initial);
  await key.fill('synthetic_settings_draft');
  await dialog.getByLabel('文案生成').uncheck();
  await dialog.getByRole('tab', { name: '默认参数', exact: true }).click();
  const privacy = dialog.locator('#privacy-account-defaults');
  await expect(privacy).toBeEnabled();
  await privacy.selectOption('private');
  assert.deepEqual(await measure('desktop-defaults'), initial);
  await capture('desktop-defaults');
  await dialog.getByRole('tab', { name: '直播配置包', exact: true }).click();
  await dialog.locator('#api-settings-target').selectOption({ index: 1 });
  await expect(dialog.locator('#privacy-profile-editor')).toBeVisible();
  await dialog.getByLabel('自动回复观众', { exact: true }).check();
  const prompt = dialog.locator('#chat-prompt-profile-editor');
  await prompt.fill('仅保留在本次设置窗口中的草稿。');
  const scroll = dialog.locator('[data-state="active"] > .settings-panel-body');
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const scrollTop = await scroll.evaluate(el => el.scrollTop);
  assert(scrollTop > 0, 'long profile editor should scroll internally');
  assert.deepEqual(await measure('desktop-profiles'), initial);
  await capture('desktop-profiles');
  await dialog.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  await expect(key).toHaveValue('synthetic_settings_draft');
  await expect(dialog.getByLabel('文案生成')).not.toBeChecked();
  await dialog.getByRole('tab', { name: '默认参数', exact: true }).click();
  await expect(privacy).toHaveValue('private');
  await dialog.getByRole('tab', { name: '直播配置包', exact: true }).click();
  await expect(prompt).toHaveValue('仅保留在本次设置窗口中的草稿。');
  assert.equal(await scroll.evaluate(el => el.scrollTop), scrollTop);
  await dialog.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('测试保存失败');
  await expect(key).toHaveValue('synthetic_settings_draft');
  assert.deepEqual(await measure('desktop-save-error'), initial);
  failSave = false;
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(dialog.getByRole('status')).toContainText('已保存');
  await capture('desktop-ai');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.deepEqual(await measure('desktop-after-confirm'), initial);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(dialog.getByRole('tablist')).toBeHidden();
    const mobile = await measure(`mobile-${width}`);
    assert.equal(mobile.width, width); assert.equal(mobile.height, 844);
    await capture(`mobile-${width}-detail`);
    await dialog.getByRole('button', { name: '返回分类', exact: true }).click();
    await expect(dialog.getByRole('tablist')).toBeVisible();
    await capture(`mobile-${width}-categories`);
    await dialog.getByRole('tab', { name: '默认参数', exact: true }).click();
    await expect(privacy).toHaveValue('private');
    assert.deepEqual(await measure(`mobile-${width}-defaults`), mobile);
    await dialog.getByRole('button', { name: '返回分类', exact: true }).click();
    await dialog.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(key).toHaveValue('');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  assert.equal(writes, 2); assert.deepEqual(errors, []);
  await writeFile(`${output}/geometry.json`, JSON.stringify(geometry, null, 2) + '\n');
  console.log('PASS settings center: stable geometry, scroll retention, three drafts, save recovery, close protection, 1440/390/320px');
} finally { await browser.close(); }
