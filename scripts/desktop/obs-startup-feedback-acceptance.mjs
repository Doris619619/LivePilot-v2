/** OBS 慢启动界面回归：真实静态页面配合模拟桥接，验证轮询期间无误报及最终失败可见。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('desktop/out');
const output = path.resolve('docs/desktop/screenshots/startup-feedback');
await mkdir(output, { recursive: true });
/** 仅提供隔离静态页面；所有设备和连接观测来自下方合成夹具。 */
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep)) throw Error('Outside static root');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [780, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      /** 模拟启动期间 OBS 进程已存在、控制接口尚未监听的 Agent 快照。 */
      const problem = (code, id, message) => ({ version: 1, source: 'desktop', domain: 'obs', code, target: { instanceId: id }, severity: 'error', stage: '读取 OBS 状态', outcome: 'unknown', observedAt: Date.now(), actions: ['refresh', 'settings'], message });
      const transient = problem('OBS_NOT_LISTENING', 'main', '模拟：启动中端口尚未就绪');
      const state = { version: '0.1.14 · 模拟验收', busy: false, dataRoot: 'D:/模拟数据', paired: true, online: true, agentRunning: true, autoStart: false,
        instances: ['main', 'second'].map((id, index) => ({ id, name: 'OBS ' + (index + 1), initialized: true, managed: true })),
        checks: [{ id: 'network-main', instanceId: 'main', label: 'OBS 1', status: 'error', code: 'not-listening', checkedAt: Date.now() - 1000 }, { id: 'network-second', instanceId: 'second', label: 'OBS 2', status: 'error', code: 'port-conflict', message: '模拟：另一个 OBS 端口冲突', checkedAt: Date.now() }],
        snapshots: [{ instance: { id: 'main' }, observedAt: Date.now(), dashboard: { obs: { ready: false, running: true, problem: transient }, youtube: {}, media: { videos: [], music: [] }, configuration: { missing: [] } } }], update: { status: 'idle' } };
      const fixture = window.startupFixture = { state, reads: 0, finish: null };
      window.liveNest = {
        session: async () => ({ authenticated: true, username: '模拟验收' }), updateState: async () => state,
        readState: async () => { fixture.reads++; return { ok: true, state }; },
        act: async (action, input) => {
          state.busy = true;
          state.activity = { action, instanceId: input.id, step: 2, status: 'running', stage: '正在启动并等待控制连接（最多约 60 秒）', startedAt: Date.now() };
          return new Promise(resolve => {
            /** 由测试显式结束操作，使轮询与切页发生在同一次等待过程中。 */
            fixture.finish = success => {
              state.busy = false;
              if (success) {
                state.activity = { ...state.activity, status: 'complete', stage: '已启动并确认控制连接；未执行开播操作' };
                Object.assign(state.checks[0], { status: 'ready', controlReady: true, code: undefined, checkedAt: Date.now() });
                // 保留比最终检查旧的失败快照，检验完成后不会重新闪现警告。
                resolve({ ok: true, state });
              } else {
                const failure = problem('OBS_READY', input.id, '模拟：OBS 连接检查超时，请检查对应 OBS。');
                state.activity = { ...state.activity, status: 'failed', problem: failure };
                resolve({ ok: false, problem: failure });
              }
            };
          });
        },
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).waitFor();
    // 连接问题在没有启动操作时应可见，不能靠永久隐藏错误通过回归。
    await page.locator('#setup-obs-main [role="alert"]').waitFor();
    await page.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).click();
    await page.waitForFunction(() => window.startupFixture.finish !== null);
    const reads = await page.evaluate(() => window.startupFixture.reads);
    await page.waitForFunction(count => window.startupFixture.reads >= count + 2, reads);
    assert.equal(await page.locator('#setup-obs-main [role="alert"]').count(), 0);
    await page.getByText('正在启动并连接…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '本机 OBS', exact: true }).click();
    const main = page.locator('.desktop-instance').filter({ has: page.getByRole('heading', { name: 'OBS 1', exact: true }) });
    const second = page.locator('.desktop-instance').filter({ has: page.getByRole('heading', { name: 'OBS 2', exact: true }) });
    assert.equal(await main.getByRole('alert').count(), 0);
    assert.equal(await second.getByRole('alert').count(), 1);
    assert.equal(await main.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).isDisabled(), true);
    await capture(page, 'waiting-' + width);
    await page.evaluate(() => window.startupFixture.finish(true));
    await main.getByText('控制已连接（上次检查）', { exact: true }).waitFor();
    assert.equal(await main.getByRole('alert').count(), 0);
    // 新一轮失败保留最终超时，而不是吞掉全部错误或继续显示“正在启动”。
    await main.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).click();
    await main.getByText('正在启动并连接…', { exact: true }).waitFor();
    await page.evaluate(() => window.startupFixture.finish(false));
    await main.getByRole('alert').locator(':scope > p').filter({ hasText: '模拟：OBS 连接检查超时，请检查对应 OBS。' }).waitFor();
    assert.equal(await main.getByRole('alert').count(), 1);
    await main.getByText('本次控制连接未确认', { exact: true }).waitFor();
    assert.equal(await main.getByText('正在启动并等待控制连接（最多约 60 秒）', { exact: true }).count(), 0);
    await page.waitForFunction(() => !document.querySelector('[aria-label="重新检查 OBS 1"]').disabled);
    await capture(page, 'timeout-' + width);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: startup polling, cross-page progress, other-instance failure, stale snapshot after success, final timeout, 780/1280px');
} finally { await browser.close(); server.close(); }

/** 截图标记合成验收，核对窄窗口溢出及可操作按钮尺寸。 */
async function capture(page, name) {
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.main-wrapper')?.scrollTo(0, 0); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const button of await page.getByRole('button', { name: /^启动并检查 OBS/ }).all()) assert.ok((await button.boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}
