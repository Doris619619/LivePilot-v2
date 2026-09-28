/** 验收 localhost 合成预览的详情、AI、草稿和响应式布局；禁止访问真实服务。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const origin = 'http://127.0.0.1:3021';
const output = path.resolve('.data/preview/broadcast-acceptance');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { const url = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'data:' ? route.continue() : route.abort(); });
  // 即使开发环境配置了真实 Key，自动化回归也只使用合成 AI 响应。
  await page.route('**/api/broadcast-assets', async route => {
    const input = route.request().postDataJSON();
    if (input.action === 'ai-generate') return route.fulfill({ json: { demo: true, title: 'Lofi Night | Music for Study', description: 'Warm beats for a peaceful night. #lofi' } });
    return route.fallback();
  });
  await page.goto(origin + '/workspace', { waitUntil: 'networkidle' });
  const first = page.locator('#instance-preview_liang-main');
  const second = page.locator('#instance-preview_liang-obs_2');
  const title = first.locator('[id^="broadcast-title-"]');
  await title.waitFor();
  assert.equal(await first.locator('[id^="broadcast-privacy-"]').inputValue(), 'public');
  assert.equal(await first.getByRole('button', { name: '开始直播', exact: true }).isDisabled(), true);
  await first.getByRole('button', { name: '生成并填入', exact: true }).click();
  await first.getByText('演示文案已填入，未调用真实 DeepSeek API。', { exact: true }).waitFor();
  assert.match(await title.inputValue(), /Lofi/);
  assert.match(await first.locator('[id^="broadcast-description-"]').inputValue(), /#lofi/);
  assert.equal(await second.locator('[id^="broadcast-title-"]').inputValue(), '');
  await first.getByRole('button', { name: '撤销填入', exact: true }).click();
  assert.equal(await title.inputValue(), '');
  await first.getByRole('button', { name: '生成并填入', exact: true }).click();
  await first.getByText('演示文案已填入，未调用真实 DeepSeek API。', { exact: true }).waitFor();
  await first.getByRole('tab', { name: '发布设置', exact: true }).click();
  await first.getByRole('button', { name: '读取频道列表', exact: true }).click();
  await first.getByLabel('学习与专注', { exact: true }).check();
  await first.locator('[id^="broadcast-privacy-"]').selectOption('unlisted');
  await first.locator('[id^="broadcast-audience-"]').selectOption('true');
  await page.reload({ waitUntil: 'networkidle' });
  assert.match(await title.inputValue(), /Lofi/);
  assert.equal(await first.locator('[id^="broadcast-privacy-"]').inputValue(), 'unlisted');
  assert.equal(await first.locator('[id^="broadcast-audience-"]').inputValue(), 'true');
  await first.getByRole('tab', { name: '发布设置', exact: true }).click();
  await first.locator('[id^="broadcast-privacy-"]').selectOption('public');
  await first.locator('[id^="broadcast-audience-"]').selectOption('false');
  await first.getByRole('tab', { name: '直播内容', exact: true }).click();
  // 合成 PNG 仅用于文件选择与本地预览，不传给外部 API。
  await first.locator('input[type=file]').setInputFiles({ name: 'demo-cover.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64') });
  await first.getByText('已上传：demo-cover.png', { exact: true }).waitFor();
  await first.getByRole('button', { name: '移除封面', exact: true }).click();
  assert.equal(await first.getByRole('button', { name: '开始直播', exact: true }).isEnabled(), true);
  await page.setViewportSize({ width: 1600, height: 1800 });
  await first.locator('.broadcast-settings').screenshot({ path: path.join(output, 'desktop.png'), animations: 'disabled' });
  for (const [width, height, name] of [[390, 844, 'phone'], [768, 1024, 'tablet'], [1024, 768, 'landscape']]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' horizontal overflow');
    await first.locator('.broadcast-settings').screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1600, height: 1100 });
  await first.getByRole('button', { name: '开始直播', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#broadcast-title-preview_liang-main')?.matches(':disabled') === true);
  await first.getByRole('button', { name: '结束直播', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#broadcast-title-preview_liang-main')?.matches(':disabled') === false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['default public', 'required title', 'AI English demo and undo', 'instance isolation', 'playlist selection', 'refresh draft', 'thumbnail select and remove', '390/768/1024/1600 layout', 'simulated start locks details', 'simulated stop unlocks details'], errors }, null, 2));
  console.log('Broadcast UI acceptance passed: ' + output);
} finally { await browser.close(); }
