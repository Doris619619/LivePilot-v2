/** 隔离预览的统一发布配置验收：合成发布状态的保存与复用、失败恢复、跨类型草稿、桌面/手机；禁止开播和发布。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const origin = 'http://127.0.0.1:3021';
const output = 'docs/screenshots/publication-settings';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], saved = [];
let failSave = true;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => {
  const request = route.request();
  if (new URL(request.url()).origin !== origin) return route.abort();
  if (['GET', 'HEAD'].includes(request.method())) return route.continue();
  const data = request.postDataJSON();
  if (request.url().endsWith('/api/publishing-templates')) {
    if (failSave) return route.fulfill({ status: 503, json: { error: '模拟保存失败，请重试。' } });
    saved.push(data); return route.continue();
  }
  if (request.url().endsWith('/api/broadcast-profiles') && data.action === 'save') return route.continue();
  if (request.url().endsWith('/api/publishing') && ['packages', 'account-directory'].includes(data.action)) return route.continue();
  return route.fulfill({ status: 409, json: { error: '验收禁止开播、发布或授权。' } });
});
const dialog = page.getByRole('dialog', { name: '设置', exact: true });
/** 稳定尺寸和没有横向溢出；正文按自身滚动，外框不滚动。 */
async function measure(width) {
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  assert.equal(Math.round(box.width), width > 600 ? 900 : width);
  assert.equal(Math.round(box.height), width > 600 ? 680 : 844);
  assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1));
}
try {
  await page.goto(origin + '/workspace');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await dialog.getByRole('tab', { name: '发布配置', exact: true }).click();
  await expect(dialog.locator('#api-settings-target')).toHaveCount(0);
  await dialog.locator('#privacy-profile-editor').selectOption('private');
  await dialog.getByLabel('自动回复观众', { exact: true }).check();
  await dialog.locator('#chat-prompt-profile-editor').fill('直播配置草稿保留');
  await dialog.getByRole('button', { name: '视频发布配置包', exact: true }).click();
  await dialog.getByRole('button', { name: '新建视频发布配置包', exact: true }).click();
  const packageName = '夜间精选 · 私密 ' + Date.now();
  await dialog.getByLabel('配置名称', { exact: true }).fill(packageName);
  await dialog.getByLabel('标题模板', { exact: true }).fill('频道精选 · {{packageName}}');
  await dialog.getByRole('combobox', { name: '是否专为儿童制作', exact: true }).selectOption('false');
  await dialog.getByRole('combobox', { name: '可见性', exact: true }).selectOption('private');
  await dialog.getByRole('button', { name: '直播配置包', exact: true }).click();
  await expect(dialog.locator('#privacy-profile-editor')).toHaveValue('private');
  await expect(dialog.locator('#chat-prompt-profile-editor')).toHaveValue('直播配置草稿保留');
  await dialog.getByRole('button', { name: '视频发布配置包', exact: true }).click();
  await expect(dialog.getByLabel('配置名称', { exact: true })).toHaveValue(packageName);
  await dialog.getByLabel('AI 自动生成标题和说明', { exact: true }).check();
  await dialog.getByRole('button', { name: 'API 设置', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'AI 服务', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: '发布配置', exact: true }).click();
  await expect(dialog.getByLabel('标题模板', { exact: true })).toHaveValue('频道精选 · {{packageName}}');
  await dialog.getByLabel('AI 自动生成标题和说明', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '保存配置包', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('模拟保存失败');
  await expect(dialog.getByLabel('配置名称', { exact: true })).toHaveValue(packageName);
  failSave = false;
  await dialog.getByRole('button', { name: '保存配置包', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(`已保存「${packageName}」`);
  assert(!('agentId' in saved[0]) && !('accountId' in saved[0]) && !('channelId' in saved[0]) && !('playlistIds' in saved[0]));
  assert.equal(saved.length, 1); assert.equal(saved[0].privacy, 'private');
  await dialog.getByRole('button', { name: '编辑 ' + packageName, exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '可见性', exact: true })).toHaveValue('private');
  await expect(dialog.getByLabel('标题模板', { exact: true })).toHaveValue('频道精选 · {{packageName}}');
  await dialog.getByLabel('标题模板', { exact: true }).fill('修订版 · {{packageName}}');
  await dialog.getByRole('button', { name: '保存配置包', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(`已保存「${packageName}」`);
  assert.equal(saved.at(-1).revision, 2); assert.equal(saved.at(-1).id, saved[0].id);
  await dialog.getByRole('button', { name: '编辑 ' + packageName, exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
    await measure(width);
    await dialog.getByLabel('配置名称', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/video-${width}.png` });
    await dialog.getByRole('button', { name: '直播配置包', exact: true }).click();
    await dialog.getByRole('combobox', { name: '直播配置包', exact: true }).scrollIntoViewIfNeeded();
    await measure(width);
    await page.screenshot({ path: `${output}/live-${width}.png` });
    await dialog.getByRole('button', { name: '视频发布配置包', exact: true }).click();
    await expect(dialog.getByLabel('标题模板', { exact: true })).toHaveValue('修订版 · {{packageName}}');
  }
  await dialog.getByLabel('配置名称', { exact: true }).fill('未保存草稿');
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await expect(dialog.getByText('放弃未保存的修改并返回配置包列表？')).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑配置包', exact: true }).click();
  await expect(dialog.getByLabel('配置名称', { exact: true })).toHaveValue('未保存草稿');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃修改并关闭', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '视频发布', exact: true }).click();
  await page.getByRole('button', { name: '视频发布配置包', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '编辑 ' + packageName, exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '直播配置包', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '视频发布配置包', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('PASS unified publication settings (synthetic preview API): saved create/edit, revision, failure recovery, drafts, API navigation, shared entry, 1440/390/320px');
} catch (error) { console.error(await page.locator("body").innerText()); await page.screenshot({ path: `${output}/failure.png` }); throw error; } finally { await browser.close(); }
