/** 更新恢复验收：真实隔离 Electron IPC + 明确标记的模拟故障界面；不启动真实安装或 OBS。 */
import { _electron, chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const data = await mkdtemp(path.join(tmpdir(), 'livenest-update-acceptance-'));
const output = path.resolve('docs/desktop/screenshots/update'); await mkdir(output, { recursive: true });
const env = { ...process.env, LIVENEST_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const application = await _electron.launch({ executablePath: require('electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
try {
  const page = await application.firstWindow(); await page.getByRole('heading', { name: '登录 LiveNest' }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), data);
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  for (let attempt = 0; attempt < 180; attempt++) { if (!(await page.evaluate(() => window.liveNest.updateState())).busy) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal((await page.evaluate(() => window.liveNest.updateState())).busy, false);
  const local = await page.evaluate(() => window.liveNest.updateState()); assert.deepEqual(Object.keys(local).sort(), ['busy', 'update', 'version']);
  assert.equal(await page.evaluate(async () => { try { await window.liveNest.state(); return false; } catch { return true; } }), true);
  assert.equal((await page.evaluate(() => window.liveNest.act('add'))).ok, false);
  assert.equal((await page.evaluate(() => window.liveNest.update('pair'))).ok, false);
  const notDownloaded = await page.evaluate(() => window.liveNest.update('update-install')); assert.equal(notDownloaded.ok, false); assert.equal(notDownloaded.problem.code, 'UPDATE_STATE', JSON.stringify(notDownloaded));
  assert.equal((await page.evaluate(() => window.liveNest.update('update-check'))).ok, true);
  assert.equal((await page.evaluate(() => window.liveNest.updateState())).update.status, 'preview');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(780, 850));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('PASS real Electron: isolated profile, update without login/data directory, non-update IPC denied, minimal DTO, renderer isolation, 780px');
} finally {
  await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners('before-quit'); for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close'); });
  await application.close();
}
const root = path.resolve('desktop/out');
/** 只提供本次静态构建，不访问真实服务。 */
const server = createServer(async (req, res) => { try { const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html')); if (!file.startsWith(root + path.sep)) throw Error(); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 850 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let authenticated = false;
    const state = { version: '0.1.3（模拟）', busy: false, update: { status: 'available', version: '0.1.4', message: '发现新版本 0.1.4' } };
    const calls = []; let finish;
    const fixture = window.updateFixture = { state, calls, fail() { const problem = { version: 1, source: 'desktop', code: 'OBS_MAINTENANCE', domain: 'update', target: {}, severity: 'error', stage: '准备安装更新', outcome: 'not-sent', observedAt: Date.now(), actions: ['help', 'support'], message: '更新尚未开始安装。模拟 OBS 2 正在录制，请在完成后重试。' }; state.busy = false; state.update = { ...state.update, status: 'error', stage: 'install', message: problem.message, problem }; finish({ ok: false, state: structuredClone(state), problem }); }, cancel() { state.busy = false; finish({ ok: true, state: structuredClone(state), cancelled: true }); } };
    window.liveNest = {
      session: async () => ({ authenticated, username: '模拟客户' }), login: async () => { authenticated = true; return { ok: true }; }, logout: async () => { authenticated = false; },
      state: async () => ({ version: state.version, busy: false, dataRoot: 'C:/模拟数据/LiveNest', paired: true, connectionError: 'AGENT_AUTH', online: false, agentRunning: true, autoStart: false, instances: [], snapshots: [], checks: [], update: { status: 'downloaded', message: '旧配置快照不应覆盖更新错误' } }),
      act: async action => { throw Error('Unexpected authenticated action: ' + action); },
      updateState: async () => structuredClone(state),
      update: async action => { calls.push(action); state.busy = true; if (calls.length === 1) state.update = { ...state.update, status: 'preparing', stage: 'install', message: '正在核对 OBS 状态并等待 Agent 任务完成…' }; return new Promise(resolve => { finish = resolve; }); },
    };
    void fixture;
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '更新并重启', exact: true }).click();
  await page.getByRole('button', { name: '正在准备重启…', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '正在准备重启…' }).isDisabled(), true);
  await page.evaluate(() => window.updateFixture.fail()); await page.getByRole('button', { name: '重试重启更新' }).waitFor();
  assert.equal(await page.getByText('下载完成，可以重启更新', { exact: true }).count(), 0);
  await capture(page, 'login-update-failure');
  await page.getByRole('button', { name: '重试重启更新' }).click(); await page.evaluate(() => window.updateFixture.fail());
  await page.waitForFunction(() => !document.querySelector('.login-update button')?.disabled);
  assert.deepEqual(await page.evaluate(() => window.updateFixture.calls), ['update-apply', 'update-install']);
  await page.getByLabel('账号', { exact: true }).fill('模拟客户'); await page.getByLabel('密码', { exact: true }).fill('fixture-only'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '重试重启更新' }).waitFor();
  assert.equal(await page.getByText('旧配置快照不应覆盖更新错误', { exact: true }).count(), 0);
  await capture(page, 'paired-expired-update-failure');
  await page.getByRole('button', { name: '软件更新：更新需要处理' }).click(); await page.getByRole('region', { name: '软件更新详情' }).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('region', { name: '软件更新详情' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '软件更新：更新需要处理' }).evaluate(button => button === document.activeElement), true);
  await page.evaluate(() => { window.updateFixture.state.update = { status: 'available', version: '0.1.4', message: '发现新版本 0.1.4' }; });
  await page.locator('header').getByRole('button', { name: '更新并重启', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.updateFixture.calls), ['update-apply', 'update-install', 'update-apply']);
  await page.evaluate(() => window.updateFixture.fail());
  assert.deepEqual(errors, []); console.log('PASS simulated UI: login update, preparing, precise error, retry original action, revoked pairing, stale full-state isolation, keyboard, 780px');
} finally { await browser.close(); server.close(); }
/** 截图显式说明为模拟故障；同时断言窄屏不会横向溢出。 */
async function capture(page, name) { await page.evaluate(() => { let label = document.getElementById('fixture-label'); if (!label) { label = document.createElement('div'); label.id = 'fixture-label'; label.textContent = '模拟故障 · 隔离验收 · 未操作真实直播'; label.style.cssText = 'padding:8px;background:#254131;color:white;font-size:14px'; document.body.prepend(label); } }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); }
