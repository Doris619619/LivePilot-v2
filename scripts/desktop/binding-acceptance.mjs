/** 绑定恢复与登录布局隔离验收：真实 Electron 桥接和标明模拟故障的浏览器截图。 */
import { _electron, chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const data = await mkdtemp(path.join(tmpdir(), 'livenest-binding-acceptance-'));
const output = path.resolve('docs/desktop/screenshots/binding'); await mkdir(output, { recursive: true });
const env = { ...process.env, LIVENEST_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const application = await _electron.launch({ executablePath: require('electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
let originalClipboard;
try {
  const page = await application.firstWindow(); await page.getByRole('heading', { name: '登录 LiveNest' }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), data);
  const result = await page.evaluate(() => window.liveNest.readState());
  assert.equal(result.ok, false); assert.equal(result.problem.code, 'AUTH'); assert.equal('state' in result, false);
  originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  await page.evaluate(problem => window.liveNest.copyProblem(problem), result.problem);
  const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(JSON.parse(copied).code, 'AUTH'); assert.equal(copied.includes('message'), false);
  const invalid = await page.evaluate(async problem => { try { await window.liveNest.copyProblem({ ...problem, token: 'fixture' }); return false; } catch { return true; } }, result.problem);
  assert.equal(invalid, true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(780, 850));
  const bounds = await page.evaluate(() => ({ submit: document.querySelector('.login-submit').getBoundingClientRect().bottom, secondary: document.querySelector('.login-secondary-actions').getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
  assert.ok(bounds.secondary - bounds.submit >= 15); assert.equal(bounds.overflow, false);
  await capture(page, 'login-780');
  console.log('PASS real Electron: structured auth failure, native clipboard and whitelist, login spacing at 780px');
} finally {
  if (originalClipboard !== undefined) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard);
  await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners('before-quit'); for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close'); });
  await application.close();
}
const root = path.resolve('desktop/out');
/** 只托管本次构建，不访问生产服务。 */
const server = createServer(async (req, res) => { try { const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html')); if (!file.startsWith(root + path.sep)) throw Error(); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 850 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { version: '0.1.6 模拟', busy: false, dataRoot: 'C:/模拟数据', paired: false, online: false, agentRunning: false, autoStart: false, instances: [{ id: 'main', name: '模拟 OBS', initialized: true }], snapshots: [], checks: [], update: { status: 'idle' } };
    const problem = { version: 1, source: 'desktop', code: 'FORBIDDEN', domain: 'account', target: {}, severity: 'error', stage: '读取本机状态', outcome: 'rejected', observedAt: Date.now(), actions: ['login', 'refresh'], message: '模拟故障：当前账号没有此电脑的权限。' };
    const fixture = window.bindingFixture = { failed: true, reads: 0, calls: [], copied: false };
    window.liveNest = { session: async () => ({ authenticated: true, username: '模拟客户' }), logout: async () => {}, readState: async () => { fixture.reads++; return fixture.failed ? { ok: false, problem } : { ok: true, state }; }, updateState: async () => state, copyProblem: async () => { fixture.copied = true; return true; }, act: async action => { fixture.calls.push(action); return { ok: true, state }; } };
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByText('当前账号无权访问这台电脑', { exact: true }).waitFor();
  assert.equal(await page.getByText('正在读取本机配置…', { exact: true }).count(), 0);
  assert.equal(await page.getByText('连接或服务暂不可用', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '复制诊断摘要' }).click(); await page.getByText('摘要已复制，请交给管理员', { exact: true }).waitFor();
  await capture(page, 'permission-error-780');
  const before = await page.evaluate(() => window.bindingFixture.reads);
  await page.getByRole('button', { name: '重新读取', exact: true }).last().click();
  assert.ok(await page.evaluate(() => window.bindingFixture.reads) > before);
  assert.deepEqual(await page.evaluate(() => window.bindingFixture.calls), []);
  await page.evaluate(() => { window.bindingFixture.failed = false; });
  await page.getByRole('heading', { name: '连接这台电脑' }).waitFor();
  await page.getByRole('textbox', { name: '配对码', exact: true }).fill('LN1.fixture');
  await capture(page, 'unpaired-780');
  await page.setViewportSize({ width: 1280, height: 880 }); await capture(page, 'unpaired-1280');
  assert.deepEqual(errors, []); console.log('PASS simulated UI: correct permissions, no permanent loading, read-only retry, clipboard feedback, new pairing, 780/1280px');
} finally { await browser.close(); server.close(); }
/** 截图标明模拟环境；同时检查无横向溢出。 */
async function capture(page, name) {
  await page.evaluate(() => { let label = document.getElementById('fixture-label'); if (!label) { label = document.createElement('div'); label.id = 'fixture-label'; label.textContent = '模拟故障 / 隔离验收 · 未操作真实账号和直播'; label.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;padding:8px;background:#254131;color:white;font-size:14px'; document.body.append(label); } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
