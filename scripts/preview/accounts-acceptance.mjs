/** 隔离预览账号与下载页浏览器验收；仅操作 preview:local 创建的合成客户。 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'docs/screenshots/accounts-0.1.8'; await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:3023/admin'); await page.getByRole('button', { name: '客户账号', exact: true }).click();
  await page.getByRole('button', { name: '重置 Do 的密码', exact: true }).waitFor();
  const username = 'QA_' + Date.now();
  await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('初始密码', { exact: true }).fill('synthetic-password-only'); await page.getByLabel('再次输入密码', { exact: true }).fill('synthetic-password-only');
  await page.getByRole('button', { name: '创建客户账号', exact: true }).click(); await page.getByText(`客户 ${username} 已创建，可以登录网页和客户端。`, { exact: true }).waitFor();
  await page.getByRole('button', { name: `重置 ${username} 的密码`, exact: true }).click();
  await page.getByLabel('新密码', { exact: true }).fill('synthetic-reset-only'); await page.getByLabel('再次输入密码', { exact: true }).fill('synthetic-reset-only');
  await page.getByRole('button', { name: '保存新密码', exact: true }).click(); await page.getByText(`${username} 的密码已重置，旧登录会话已撤销。`, { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回创建账号', exact: true }).click();
  await capture(page, 'customers-1280'); await page.setViewportSize({ width: 390, height: 844 }); await capture(page, 'customers-390');
  const response = await page.request.get('http://127.0.0.1:3021/api/admin/accounts'); assert.equal(response.status(), 403);
  await page.goto('http://127.0.0.1:3023/download'); await page.getByRole('link', { name: '下载 0.1.7 ↓', exact: true }).waitFor({ timeout: 25000 });
  assert.ok(await page.getByRole('link', { name: /^下载 0\.1\./ }).count() >= 4);
  await capture(page, 'history-390'); await page.setViewportSize({ width: 1280, height: 900 }); await capture(page, 'history-1280');
  assert.deepEqual(errors, []); console.log('PASS preview customer create/reset, customer API denial, public historical downloads and 390/1280px');
} finally { await browser.close(); }
/** 截图标明预览数据，并验证不横向溢出。 */
async function capture(page, name) {
  await page.evaluate(() => { if (!document.getElementById('qa-note')) { const note = document.createElement('div'); note.id = 'qa-note'; note.textContent = '模拟数据 / 隔离界面验收 · 未操作生产账号'; note.style.cssText = 'padding:10px;background:#254131;color:white'; document.body.prepend(note); } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
