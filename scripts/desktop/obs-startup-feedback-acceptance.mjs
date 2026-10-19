/** 合成桌面验收：启动阶段、异常恢复、历史详情及紧凑成功操作；不连接真实设备。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('desktop/out');
const output = path.resolve(process.env.LIVENEST_STARTUP_SCREENSHOTS || 'docs/desktop/screenshots/startup-feedback');
await mkdir(output, { recursive: true });
/** 隔离静态服务只使用随机本机端口。 */
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
  for (const width of [390, 780, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Synthetic UI error:', error.message); });
    await page.addInitScript(() => {
      const state = { version: '0.1.15 · 模拟验收', busy: false, dataRoot: 'D:/模拟数据', paired: true, online: true, agentRunning: true, autoStart: false,
        instances: ['main', 'second'].map((id, index) => ({ id, name: 'OBS ' + (index + 1), initialized: true, managed: true, port: 4457 + index * 2, exe: 'D:/模拟数据/OBS-' + (index + 1) + '/bin/64bit/obs64.exe' })), obsLaunches: [],
        checks: [{ id: 'network-main', instanceId: 'main', label: 'OBS 1', status: 'pending', code: 'not-running', checkedAt: Date.now() }, { id: 'network-second', instanceId: 'second', label: 'OBS 2', status: 'error', code: 'port-conflict', message: '模拟：另一个 OBS 端口冲突', checkedAt: Date.now() }], snapshots: [], update: { status: 'idle' } };
      const f = window.startupFixture = { state, reads: 0, starts: 0, disconnected: false, finish: null };
      /** 保存本轮宿主状态，后续读取和复查不会覆盖历史。 */
      const remember = () => { state.obsLaunches = [state.activity]; };
      f.stage = (phase, stale = false) => {
        state.activity = { ...state.activity, startedAt: Date.now() - 35_000, obsStartup: { phase, deadlineAt: Date.now() + 25_000, probeCount: 5, lastProbeAt: Date.now() - (stale ? 25_000 : 1000), observation: 'OBS 已运行，控制服务尚未就绪，正在继续检查。' } }; remember();
      };
      f.observe = ready => { Object.assign(state.checks[0], { status: ready ? 'ready' : 'pending', controlReady: ready, code: ready ? undefined : 'not-running', checkedAt: Date.now() }); };
      window.liveNest = {
        session: async () => ({ authenticated: true, username: '模拟验收' }), updateState: async () => state,
        readState: async () => { f.reads++; if (f.disconnected) throw Error('synthetic IPC failure'); if (f.hung) return new Promise(() => {}); return { ok: true, state }; },
        act: async (action, input) => {
          if (action === 'diagnose-obs') { f.observe(true); state.activity = { action, instanceId: input.id, status: 'complete', step: 2, stage: '复查完成', startedAt: Date.now(), endedAt: Date.now() }; return { ok: true, state }; }
          if (action !== 'launch-obs') return { ok: true, state };
          f.starts++; state.busy = true;
          state.activity = { action, instanceId: input.id, attemptId: 'fixture-' + f.starts, step: 2, status: 'running', stage: '正在检查并启动 OBS', startedAt: Date.now(), obsStartup: { phase: 'process', deadlineAt: Date.now() + 60_000, probeCount: 0 } }; remember();
          return new Promise(resolve => {
            /** 失败响应刻意不返回 state，检验下一次轮询和失败记录的合并。 */
            f.finish = success => {
              state.busy = false;
              if (success) { f.observe(true); state.activity = { ...state.activity, status: 'complete', endedAt: Date.now(), obsStartup: { ...state.activity.obsStartup, phase: 'ready' } }; remember(); resolve({ ok: true, state }); }
              else {
                const failure = { version: 1, source: 'desktop', domain: 'obs', code: 'OBS_READY', target: { instanceId: input.id }, severity: 'error', stage: '检查 OBS', outcome: 'unknown', observedAt: Date.now(), attemptId: state.activity.attemptId, actions: ['refresh', 'settings'], message: '模拟：本轮连接检查已超时，OBS 可能仍在运行。请重新检查。' };
                state.activity = { ...state.activity, status: 'failed', endedAt: Date.now(), problem: failure }; remember(); resolve({ ok: false, problem: failure });
              }
            };
          });
        },
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await selectControlStep(page, 'main');
    const controls = page.locator('.obs-instance-controls[data-instance-id="main"]:visible');
    const details = controls.locator('[data-obs-details-panel]');
    const detailToggle = controls.locator('button[data-obs-details-toggle]');
    await controls.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).click();
    await page.waitForFunction(() => window.startupFixture.finish !== null);
    await controls.getByRole('status').filter({ hasText: /^正在检查并启动 OBS$/ }).waitFor();
    assert.equal(await controls.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).count(), 0);
    await page.evaluate(() => window.startupFixture.stage('control'));
    await controls.locator('[aria-current="step"]').filter({ hasText: '连接控制服务' }).waitFor();
    await controls.getByText('连接等待较久，检查仍在继续。', { exact: false }).waitFor();
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    assert.equal(await detailToggle.getAttribute('aria-controls'), await details.getAttribute('id'), 'detail toggle controls its original instance region');
    await detailToggle.focus();
    await page.keyboard.press('Enter');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeVisible();
    await controls.getByText('本轮最多等待 60 秒；到期停止检查，不关闭 OBS，也不会自动开播。', { exact: true }).waitFor();
    await controls.getByText('OBS 已运行，控制服务尚未就绪，正在继续检查。', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    await capture(page, 'waiting-' + width);
    await controls.getByRole('button', { name: '连接帮助', exact: true }).click();
    await navigate(page, '本机 OBS');
    await controls.locator('[aria-current="step"]').filter({ hasText: '连接控制服务' }).waitFor();
    assert.equal(await page.evaluate(() => window.startupFixture.starts), 1);
    await page.evaluate(() => window.startupFixture.stage('control', true));
    await controls.getByText('检查结果暂未更新', { exact: true }).waitFor();
    const reads = await page.evaluate(() => window.startupFixture.reads);
    await controls.getByRole('button', { name: '重新读取状态', exact: true }).click();
    await page.waitForFunction(n => window.startupFixture.reads > n, reads);
    await capture(page, 'unknown-' + width);
    await page.evaluate(() => { window.startupFixture.disconnected = true; window.startupFixture.stage('verify'); });
    await page.getByText('客户端暂时无法读取本机状态', { exact: false }).first().waitFor();
    await page.evaluate(() => { window.startupFixture.disconnected = false; window.startupFixture.stage('verify'); });
    await controls.getByText('控制服务已回应，正在确认 OBS 状态', { exact: true }).waitFor();
    if (width === 390) {
      await page.evaluate(() => { window.startupFixture.hung = true; });
      await page.getByText('客户端暂时无法读取本机状态', { exact: false }).first().waitFor();
      await page.evaluate(() => { window.startupFixture.hung = false; window.startupFixture.stage('verify'); });
      await controls.getByText('控制服务已回应，正在确认 OBS 状态', { exact: true }).waitFor();
    }
    await page.evaluate(() => window.startupFixture.finish(false));
    await controls.getByText('本轮连接检查已超时', { exact: true }).waitFor();
    assert.equal(await controls.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).count(), 0);
    await page.waitForFunction(() => !document.querySelector('[aria-label$="重新检查 OBS 1"]').disabled);
    await capture(page, 'timeout-' + width);
    await page.evaluate(() => window.startupFixture.observe(true));
    await controls.getByText('控制连接已恢复', { exact: true }).waitFor();
    assert.equal(await controls.getByRole('alert').count(), 0);
    await controls.getByRole('button', { name: /重新检查 OBS 1$/ }).click();
    await controls.getByText('上次连接检查超时；刚刚重新检测到控制已连接。', { exact: true }).waitFor();
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    assert.equal(await details.getByText('本轮最多等待 60 秒', { exact: false }).count(), 0, 'recovered connection does not repeat the expired wait contract');
    assert.equal(await controls.locator('button.btn-primary').count(), 0);
    await capture(page, 'recovered-' + width);
    await page.evaluate(() => window.startupFixture.observe(false));
    await controls.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).click();
    await page.waitForFunction(() => window.startupFixture.starts === 2);
    await detailToggle.focus();
    await page.keyboard.press('Enter');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeVisible();
    await page.evaluate(() => window.startupFixture.finish(true));
    await controls.getByText('控制已连接', { exact: true }).waitFor();
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    await navigate(page, '设备配置');
    await selectControlStep(page, 'main');
    await controls.getByText('控制已连接', { exact: true }).waitFor();
    const [group, button, toggle] = await Promise.all([controls.locator('[data-obs-status-group]').boundingBox(), controls.getByRole('button', { name: /重新检查 OBS 1$/ }).boundingBox(), detailToggle.boundingBox()]);
    assert.ok(button.width >= 136 && button.height >= 44 && toggle.height >= 44, 'successful recheck and details retain their intended target sizes');
    if (width > 390) {
      assert.ok(Math.abs(button.y + button.height / 2 - group.y - group.height / 2) < 6 && Math.abs(button.y + button.height / 2 - toggle.y - toggle.height / 2) < 6, 'status, recheck and history toggle occupy one desktop row');
      assert.ok(group.x + group.width <= button.x + 1 && button.x + button.width <= toggle.x + 1, 'desktop success groups retain status, action and details order');
    } else {
      assert.ok(group.y + group.height <= button.y + 1, 'narrow success status occupies the first row');
      assert.ok(Math.abs(button.y + button.height / 2 - toggle.y - toggle.height / 2) < 6, 'narrow recheck and details share the second row');
    }
    assert.equal(await controls.locator('button.btn-primary').count(), 0);
    const timing = details.locator('[data-obs-startup-duration]');
    await expect(details.getByText('启动检查用时', { exact: true })).toHaveCount(1);
    await expect(timing).toHaveText(/^\d+ 秒$/);
    assert.equal(await timing.count(), 1, 'success timing remains available in details');
    assert.equal(await timing.isVisible(), false, 'success timing is hidden by default');
    assert.equal(await details.getByText('本轮最多等待 60 秒', { exact: false }).count(), 0, 'success details omit the completed wait contract');
    assert.equal(await details.getByText('OBS 已运行，控制服务尚未就绪，正在继续检查。', { exact: true }).count(), 0, 'success details omit the old observation');
    await detailToggle.focus();
    await page.keyboard.press('Enter');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'true');
    await timing.waitFor();
    await page.keyboard.press('Enter');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    assert.equal(await timing.isVisible(), false, 'keyboard closes success details');
    await capture(page, 'success-' + width);
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS: 390/780/1280px stages, slow/stale/IPC, cross-page history, timeout/recovery, success disclosure, keyboard access and action placement');
} finally { await browser.close(); server.close(); }
/** 小窗口通过同一导航抽屉切换页面，验证真实响应式入口。 */
async function navigate(page, name) {
  const menu = page.getByRole('button', { name: '导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name, exact: true }).click();
}
/** 等待目标卡片和步骤挂载后再判断折叠状态，回访时仍通过原生标题打开检查面板。 */
async function selectControlStep(page, id) {
  const trigger = page.locator('#obs-step-3-' + id);
  await page.locator('#setup-obs-' + id).waitFor({ state: 'attached' });
  await trigger.waitFor({ state: 'attached' });
  if (!await trigger.isVisible()) await page.locator('#setup-obs-' + id).getByRole('button', { name: /^(继续配置|查看配置)$/ }).click();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.locator('#obs-step-panel-3-' + id + ':visible').waitFor();
}
/** 截图保留模拟账号标识，验证无横向溢出以及可操作尺寸。 */
async function capture(page, name) {
  await page.evaluate(() => { if (!document.getElementById('fixture-note')) { const note = document.createElement('div'); note.id = 'fixture-note'; note.textContent = '合成界面验收 · 未连接真实 OBS'; note.style.cssText = 'padding:8px;background:#254131;color:white'; document.body.prepend(note); } });
  await page.locator('.obs-instance-controls[data-instance-id="main"]:visible').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const button of await page.locator('.obs-instance-controls button:visible').all()) assert.ok((await button.boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}
