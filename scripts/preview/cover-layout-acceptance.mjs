/** 封面布局隔离验收：复用真实工作流样式和预览组件，合成素材，不访问业务接口。 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const output = path.resolve('docs/screenshots/preview-layout'); await mkdir(output, { recursive: true });
await mkdir('.data/cover-layout', { recursive: true });
const root = await mkdtemp(path.resolve('.data/cover-layout/run-'));
await build({ stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { MediaPreviewPanel } from './src/app/components/media-preview/media-preview';
import './src/app/globals.css'; import './src/app/components/ui/ui.css'; import './src/app/workspace-refresh.css'; import './src/app/components/broadcast-workflow.css';
createRoot(document.getElementById('root')).render(<main><p>合成界面验收 · 未连接真实设备或发布</p><h2>确认本场直播</h2><div className="workflow-review"><div className="workflow-review-copy"><h4>Midnight Window Lofi · Cozy Beats for Study, Work & Unwind</h4><p>用于检查当前封面、长标题与频道在发布卡片中的展示。</p><p>这是一份合成配置。</p></div><MediaPreviewPanel title="Midnight Window Lofi · Cozy Beats for Study, Work & Unwind" channel="示例频道" cover="/cover.svg" /></div></main>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', jsx: 'automatic', outfile: path.join(root, 'browser.js'), logLevel: 'silent' });
/** 本次静态服务只暴露显式白名单的合成页面和构建资产。 */
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/browser.css"><style>body{padding:24px}main{max-width:1100px;margin:auto}h2{margin:24px 0}</style><div id="root"></div><script src="/browser.js"></script>'); return; }
  if (!['/browser.js', '/browser.css', '/cover.svg'].includes(name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('js') ? 'text/javascript' : name.endsWith('css') ? 'text/css' : 'image/svg+xml');
  res.end(await readFile(name === '/cover.svg' ? 'public/preview/cover.svg' : path.join(root, name.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge' });
try {
  for (const width of [390, 780, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByRole('tab', { name: '预览封面／标题' }).click();
    for (const device of ['手机端', '桌面端']) {
      await page.getByRole('button', { name: device, exact: true }).click();
      const region = page.getByRole('region', { name: device === '桌面端' ? 'YouTube 桌面卡片示意' : 'YouTube 手机卡片示意' });
      await region.locator('img').evaluate(img => img.decode());
      const bounds = await region.boundingBox(); const cover = await region.locator('img').boundingBox();
      assert.ok(cover.x >= bounds.x && cover.x + cover.width <= bounds.x + bounds.width + 1);
      assert.ok(Math.abs(cover.width / cover.height - 16 / 9) < .03);
      assert.equal(await region.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await region.locator('h4').evaluate(el => getComputedStyle(el).fontSize), '16px');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `${width}-${device}-inline.png`), fullPage: true });
      await page.getByRole('button', { name: '展开预览', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'YouTube 首页预览' });
      const modal = await dialog.boundingBox(); assert.ok(modal.x >= 0 && modal.x + modal.width <= width + 1 && modal.y >= 0 && modal.y < 1000);
      await dialog.locator('img').evaluate(img => img.decode());
      // 允许 ResizeObserver 在布局完成后同步缩放及真实占位高度。
      await page.waitForFunction(() => {
        const frame = document.querySelector('[role="dialog"] [role="region"]');
        const cards = frame?.querySelectorAll('article'); if (!frame || !cards?.length) return false;
        const rect = frame.getBoundingClientRect();
        return [...cards].every(el => { const r = el.getBoundingClientRect(); return r.left >= rect.left && r.right <= rect.right + 1 && r.bottom <= rect.bottom + 1; });
      });
      await page.screenshot({ path: path.join(output, `${width}-${device}-expanded.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.textContent === '展开预览');
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS: 390/780/1440px actual workflow CSS, complete 16:9 cover, 16px title, no overflow, fitted expanded scene, Escape and focus return');
} finally { await browser.close(); server.close(); }
