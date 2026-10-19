/** 纵向 OBS 配置步骤的合成浏览器验收与可交互预览；全部宿主动作只修改内存。 */
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve('desktop/out');
const output = path.resolve(process.env.LIVENEST_STEPS_SCREENSHOTS || 'docs/desktop/screenshots/vertical-steps');
const labels = ['准备 OBS', '连接网页', '检查 OBS', '连接频道', '准备素材'];

/** 在真实构建页面启动前安装隔离桥接；示例账号、频道和动作均不访问真实电脑或网络。 */
function installFixture() {
  const readyPreview = !['pairing', 'unpaired'].includes(new URLSearchParams(location.search).get('scenario'));
  const instances = ['main', 'second'].map((id, index) => ({ id, name: 'OBS ' + (index + 1), initialized: true, managed: index === 0 || readyPreview, exe: 'D:/示例数据/OBS-' + (index + 1) + '/bin/64bit/obs64.exe', port: 4457 + index * 2 }));
  const state = { version: '界面预览 · 示例数据', busy: false, dataRoot: 'D:/示例数据/LiveNest', dataLocationReady: true, paired: true, online: true, agentRunning: true, autoStart: false, instances,
    checks: instances.map(instance => ({ id: 'network-' + instance.id, instanceId: instance.id, label: instance.name, status: 'ready', controlReady: true, checkedAt: Date.now() })), snapshots: [], update: { status: 'idle' } };
  const fixture = window.obsStepsFixture = { state, calls: [], reads: 0, rejectRename: false, holdDiagnose: false };
  /** 示例心跳只刷新快照；本机检查时间只在合成检查实际完成时更新。 */
  fixture.refresh = () => {
    for (const snapshot of state.snapshots) snapshot.observedAt = Date.now();
    return state;
  };
  /** 配对是整台电脑的状态；切换示例场景不写真实 Agent 授权。 */
  fixture.setPaired = paired => {
    state.paired = paired; state.online = paired; state.agentRunning = paired;
    state.snapshots = paired ? instances.map((instance, index) => ({ instance, observedAt: Date.now(), dashboard: { busy: false, state: { phase: 'idle', stage: '等待操作', updatedAt: new Date().toISOString() }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: index === 0 || readyPreview, channel: index === 0 || readyPreview ? '示例频道 ' + (index + 1) : '' }, media: { videos: index === 0 || readyPreview ? ['示例视频.mp4'] : [], music: index === 0 || readyPreview ? ['示例音乐.mp3'] : [] }, configuration: { missing: [], privacy: 'private', madeForKids: false } } })) : [];
  };
  /** 只改变指定实例的观测结果，供轮询期间保持当前步骤的验收使用。 */
  fixture.setControl = (id, ready) => {
    Object.assign(state.checks.find(check => check.instanceId === id), { status: ready ? 'ready' : 'pending', controlReady: ready, code: ready ? undefined : 'not-running', checkedAt: Date.now() });
    const snapshot = state.snapshots.find(item => item.instance.id === id);
    if (snapshot) snapshot.dashboard.obs.ready = ready;
  };
  fixture.setPaired(readyPreview);
  window.liveNest = {
    session: async () => ({ authenticated: true, username: '示例用户' }), logout: async () => {},
    state: async () => fixture.refresh(), readState: async () => { fixture.reads++; return { ok: true, state: fixture.refresh() }; }, updateState: async () => state,
    update: async () => ({ ok: true, state }),
    /** 合成检查默认留出可见反馈；验收可暂停并手动返回成功或失败，不接触真实 OBS。 */
    act: async (action, input = {}) => {
      fixture.calls.push({ action, ...input });
      if (action === 'diagnose-obs') return new Promise(resolve => {
        const startedAt = Date.now(); let settled = false;
        fixture.pendingDiagnose = { id: input.id, startedAt };
        state.busy = true;
        state.activity = { action, instanceId: input.id, step: 2, status: 'running', stage: '示例：正在检查 OBS 控制连接', startedAt };
        /** 只结算本轮指定实例；失败保留原观测，不生成连接成功证据。 */
        const finish = (ok, options = {}) => {
          if (settled) return; settled = true;
          delete fixture.finishDiagnose; delete fixture.pendingDiagnose;
          const endedAt = Date.now(); state.busy = false;
          if (!ok) {
            const problem = { version: 1, source: 'desktop', code: 'SYNTHETIC_DIAGNOSE', domain: 'desktop', target: { instanceId: input.id }, severity: 'error', stage: '检查 OBS', outcome: 'rejected', observedAt: endedAt, actions: ['refresh'], message: '示例：本次 OBS 检查未完成，请重新检查。' };
            state.activity = { ...state.activity, status: 'failed', stage: '检查 OBS', endedAt, problem, message: problem.message };
            return resolve({ ok: false, problem });
          }
          const previous = state.checks.find(check => check.instanceId === input.id);
          fixture.setControl(input.id, options.controlReady ?? !!previous?.controlReady);
          state.activity = { ...state.activity, status: 'complete', stage: '检查完成', endedAt };
          resolve({ ok: true, state: fixture.refresh() });
        };
        fixture.finishDiagnose = finish;
        if (!fixture.holdDiagnose) setTimeout(() => finish(true), 600);
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (action === 'pair' && fixture.holdPair) return new Promise(resolve => {
        state.activity = { action, step: 3, status: 'running', stage: '示例：正在连接网页', startedAt: Date.now() };
        /** 手动结束合成配对，验证用户切走后仍可见失败；不提交真实配对码。 */
        fixture.finishPair = () => resolve({ ok: false, problem: { version: 1, source: 'desktop', code: 'SYNTHETIC_PAIR', domain: 'desktop', target: {}, severity: 'error', stage: '连接网页', outcome: 'rejected', observedAt: Date.now(), actions: ['refresh'], message: '示例：本次配对未完成，请保留配对码后重试。' } });
      });
      if (action === 'rename' && fixture.rejectRename) return { ok: false, problem: { version: 1, source: 'desktop', code: 'SYNTHETIC_RENAME', domain: 'desktop', target: { instanceId: input.id }, severity: 'error', stage: '保存实例名称', outcome: 'rejected', observedAt: Date.now(), actions: ['refresh'], message: '示例：名称暂未保存，输入已保留。' } };
      if (action === 'rename') { const instance = instances.find(item => item.id === input.id); if (instance) instance.name = input.name; }
      if (action === 'pair' || action === 'start') fixture.setPaired(true);
      if (action === 'unpair') fixture.setPaired(false);
      if (action === 'launch-obs') fixture.setControl(input.id, true);
      if (action === 'prepare') { const instance = instances.find(item => item.id === input.id); if (instance) instance.initialized = true; }
      if (action === 'add') { const number = instances.length + 1; instances.push({ id: 'example-' + number, name: 'OBS ' + number, initialized: true, managed: true, exe: 'D:/示例数据/OBS-' + number + '/bin/64bit/obs64.exe', port: 4455 + number * 2 }); }
      return { ok: true, state: fixture.refresh() };
    },
  };
  /** 等页面完成加载后补充持久示例标识，避免在 React 水合前改变其 DOM。 */
  window.addEventListener('load', () => setTimeout(() => {
    const note = document.createElement('aside'); note.id = 'fixture-note'; note.setAttribute('role', 'note'); note.textContent = '示例数据 · 未连接真实 OBS';
    note.style.cssText = 'position:fixed;right:12px;bottom:10px;z-index:9999;padding:7px 12px;border:1px solid #c9d8ec;border-radius:6px;background:#f4f8ff;color:#415979;font:13px/1.4 system-ui;box-shadow:0 2px 8px #20334a12;pointer-events:none';
    document.body.append(note);
  }, 100));
}

/** 仅服务本次 desktop/out，并在 HTML 的应用脚本之前注入隔离桥接；默认随机端口。 */
export async function createPreviewServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html');
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      if (!file.startsWith(root + path.sep)) throw Error('Outside static root');
      let body = await readFile(file);
      if (path.extname(file) === '.html') body = Buffer.from(body.toString().replace('<head>', '<head><script>(' + installFixture.toString() + ')();</script>'));
      res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store'); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

/** 点击原生步骤标题；跨实例先打开对应卡片，所有定位始终使用不可变实例 ID。 */
async function selectStep(page, id, number, key) {
  const trigger = page.locator('#obs-step-' + number + '-' + id);
  if (!await trigger.isVisible()) await page.locator('#setup-obs-' + id).getByRole('button', { name: /^(继续配置|查看配置)$/ }).click();
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    if (key) { await trigger.focus(); await page.keyboard.press(key); } else await trigger.click();
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#obs-step-panel-' + number + '-' + id)).toBeVisible();
  assert.equal(await page.locator('[data-obs-step-panel]:visible').count(), 1, 'only one step panel is visible across all instances');
}

/** 使用界面的真实导航入口切页，小窗口先打开侧栏抽屉。 */
async function navigate(page, name) {
  const menu = page.getByRole('button', { name: '导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name, exact: true }).click();
}

/** 原生 hidden 必须阻止程序聚焦及键盘 Tab 进入非当前步骤，不能只做视觉折叠。 */
async function assertHiddenPanelsAreInert(page) {
  const focusedHidden = await page.locator('[data-obs-step-panel][hidden]').evaluateAll(panels => panels.flatMap(panel => [...panel.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex]')]).some(element => { element.focus(); return document.activeElement === element; }));
  assert.equal(focusedHidden, false, 'controls in hidden panels cannot receive focus');
  await page.locator('button[id^="obs-step-"][aria-expanded="true"]:visible').focus();
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-obs-step-panel][hidden],.obs-detail[hidden]')), false, 'Tab skips hidden steps and instances');
  }
}

/** 纵向标题仅折叠时显示通用完成状态，运行或异常始终可见，箭头不随状态显隐移动。 */
async function assertVerticalLayout(page, id) {
  const detail = page.locator('#obs-detail-' + id);
  const triggers = detail.locator('button[id^="obs-step-"]');
  assert.equal(await triggers.count(), 5);
  assert.equal(await page.locator('.setup-progress').count(), 0, 'the duplicate horizontal progress navigation is removed');
  const boxes = await triggers.evaluateAll(items => items.map(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, text: element.textContent }; }));
  const arrows = [];
  for (let index = 0; index < boxes.length; index++) {
    assert.ok(boxes[index].height >= 44, 'step header is at least 44 CSS px');
    assert.ok(Math.abs(boxes[index].x - boxes[0].x) < 2, 'step headers share the same left edge');
    if (index) assert.ok(boxes[index].y > boxes[index - 1].y + boxes[index - 1].height - 1, 'step headers are ordered vertically');
    assert.ok((boxes[index].text.match(/已完成/g) || []).length <= 1, 'header completion label is not repeated');
    const trigger = triggers.nth(index);
    const status = trigger.locator('[data-step-header-status]');
    assert.equal(await status.count(), 1, 'each title retains one status label in the DOM');
    const state = await trigger.evaluate(element => ({ expanded: element.getAttribute('aria-expanded') === 'true', state: element.closest('li').dataset.stepState }));
    if (state.expanded && state.state === 'complete') await expect(status).toBeHidden();
    else await expect(status).toBeVisible();
    arrows.push(await trigger.locator('svg').last().boundingBox());
    const panel = detail.locator('#obs-step-panel-' + (index + 1) + '-' + id);
    assert.equal(await panel.locator('.obs-complete-badge').count(), 0, 'panels do not repeat header completion badges');
    assert.equal(await panel.getByRole('heading', { name: labels[index], exact: true }).count(), 0, 'panels do not repeat their step heading');
  }
  for (const arrow of arrows) assert.ok(Math.abs(arrow.x - arrows[0].x) < 2, 'chevrons retain the same column when completion labels are hidden');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal page overflow at the tested CSS width');
}

/** 保存真实静态构建的示例截图，范围只代表合成桥接下的界面交互。 */
async function capture(page, name) {
  await page.locator('#fixture-note').waitFor();
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.main-wrapper')?.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}

/** 无启动历史的正常连接只占紧凑状态行与固定时刻；完成文案只出现在原复查按钮内一次。 */
async function assertCompactReady(page, controls, complete = false) {
  const recheck = controls.getByRole('button', { name: /重新检查 OBS 1$/ });
  const connected = controls.getByText('控制已连接', { exact: true });
  await expect(connected).toBeVisible();
  await expect(controls.locator('details')).toHaveCount(0);
  await expect(controls.getByText(/^最近确认 \d{2}:\d{2}$/)).toBeVisible();
  const time = controls.locator('time');
  await expect(time).toHaveCount(1);
  await expect(time).toHaveText(/^\d{2}:\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(await time.getAttribute('datetime'))), 'confirmation time has a machine-readable timestamp');
  assert.equal(await controls.getByText(/秒前/).count(), 0, 'normal connected feedback does not repeat a ticking relative time');
  const [area, title, button] = await Promise.all([controls.boundingBox(), connected.boundingBox(), recheck.boundingBox()]);
  assert.ok(area.height <= 80, 'normal ready feedback is at most 80 CSS px high');
  assert.ok(button.height >= 44, 'compact recheck retains a 44 CSS px target');
  if (page.viewportSize().width > 520) assert.ok(Math.abs(button.y + button.height / 2 - title.y - title.height / 2) < 6, 'connected status and recheck share one row');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'compact ready feedback does not overflow horizontally');
  if (complete) {
    await expect(recheck).toHaveText('检查完成');
    await expect(recheck).toHaveAccessibleName('检查完成，重新检查 OBS 1');
    await expect(controls.getByText('检查完成', { exact: true })).toHaveCount(1);
    await expect(controls.getByText('检查完成', { exact: true })).toBeVisible();
    await expect(controls.getByRole('status').filter({ hasText: /^OBS 1 检查完成$/ })).toBeAttached();
  }
}

/** 手动结算示例诊断，验证即时反馈、去重、原实例路由和失败重试，不使用等待时间猜测请求阶段。 */
async function assertRecheckFeedback(page, screenshots) {
  const controls = page.locator('#obs-step-panel-3-main .obs-instance-controls');
  const recheck = controls.getByRole('button', { name: /重新检查 OBS 1$/ });
  // 缓存本实例的真实按钮节点；状态从已连接到未连接时只改布局，不替换或迁移操作控件。
  const originalRecheck = await recheck.elementHandle();
  assert.ok(originalRecheck, 'original recheck button exists before the held diagnosis');
  const initialChecks = await page.evaluate(() => window.obsStepsFixture.state.checks.map(check => ({ id: check.instanceId, at: check.checkedAt })));
  await page.evaluate(() => { window.obsStepsFixture.holdDiagnose = true; });
  await recheck.click();
  await expect(recheck).toHaveText('正在检查…');
  await expect(recheck).toHaveAccessibleName('正在检查，重新检查 OBS 1');
  await expect(recheck).toBeDisabled();
  await expect(controls.getByRole('status').filter({ hasText: '正在检查 OBS 1 的控制连接' })).toBeAttached();
  await expect(page.locator('.setup-feedback:visible')).toHaveCount(0);
  await assertVerticalLayout(page, 'main');
  await page.waitForFunction(() => window.obsStepsFixture.pendingDiagnose?.id === 'main');
  await recheck.evaluate(button => { button.click(); button.click(); });
  assert.deepEqual(await page.evaluate(() => window.obsStepsFixture.calls.filter(call => call.action === 'diagnose-obs')), [{ action: 'diagnose-obs', id: 'main' }], 'repeated clicks during one pending check submit only one original-instance request');
  if (screenshots) await capture(page, 'recheck-running');
  await selectStep(page, 'second', 3);
  await expect(page.locator('#obs-step-panel-3-second .obs-instance-controls').getByText('正在检查…', { exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.obsStepsFixture.pendingDiagnose.id), 'main', 'switching OBS never retargets the pending diagnosis');
  await navigate(page, '本机 OBS');
  await expect(page.locator('.obs-instance-controls[data-instance-id="main"]:visible').getByRole('button', { name: /重新检查 OBS 1$/ })).toHaveText('正在检查…');
  await expect(page.locator('.obs-instance-controls[data-instance-id="second"]:visible').getByText('正在检查…', { exact: true })).toHaveCount(0);
  await navigate(page, '设备配置');
  await selectStep(page, 'main', 3);
  await expect(recheck).toHaveText('正在检查…');
  await page.evaluate(() => window.obsStepsFixture.finishDiagnose(true));
  await assertCompactReady(page, controls, true);
  await expect(recheck).toBeEnabled();
  if (screenshots) await capture(page, 'recheck-complete');
  const completedChecks = await page.evaluate(() => window.obsStepsFixture.state.checks.map(check => ({ id: check.instanceId, at: check.checkedAt })));
  assert.ok(completedChecks.find(check => check.id === 'main').at > initialChecks.find(check => check.id === 'main').at, 'successful fixture diagnosis produces a new original-instance check time');
  assert.equal(completedChecks.find(check => check.id === 'second').at, initialChecks.find(check => check.id === 'second').at, 'checking one OBS does not forge a sibling check time');
  await recheck.click();
  await expect(recheck).toHaveText('正在检查…');
  await page.waitForFunction(() => typeof window.obsStepsFixture.finishDiagnose === 'function');
  await page.evaluate(() => window.obsStepsFixture.finishDiagnose(false));
  await expect(page.getByRole('alert').filter({ hasText: '示例：本次 OBS 检查未完成，请重新检查。' })).toHaveCount(1);
  await expect(controls.getByRole('status').filter({ hasText: /^OBS 1 检查未完成$/ })).toBeAttached();
  await expect(recheck).toHaveText('重新检查');
  await expect(recheck).toHaveAccessibleName('重新检查 OBS 1');
  await assertVerticalLayout(page, 'main');
  await expect(recheck).toBeEnabled();
  await expect(controls.getByText('检查完成', { exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.obsStepsFixture.state.checks.find(check => check.instanceId === 'main').checkedAt), completedChecks.find(check => check.id === 'main').at, 'failed diagnosis keeps the previous observation instead of creating a success');
  await recheck.click();
  await expect(recheck).toHaveText('正在检查…');
  await page.waitForFunction(() => typeof window.obsStepsFixture.finishDiagnose === 'function');
  assert.deepEqual(await page.evaluate(() => window.obsStepsFixture.calls.filter(call => call.action === 'diagnose-obs')), Array.from({ length: 3 }, () => ({ action: 'diagnose-obs', id: 'main' })), 'failure retry retains the original instance ID');
  await page.evaluate(() => window.obsStepsFixture.finishDiagnose(true, { controlReady: false }));
  await expect(recheck).toHaveText('检查完成');
  await expect(recheck).toHaveAccessibleName('检查完成，重新检查 OBS 1');
  await expect(controls.getByText('检查完成', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('alert').filter({ hasText: '示例：本次 OBS 检查未完成，请重新检查。' })).toHaveCount(0);
  await expect(controls.getByText('控制已连接', { exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.obsStepsFixture.state.checks.find(check => check.instanceId === 'main').controlReady), false, 'completed diagnosis can report a disconnected OBS without inventing a connection success');
  assert.equal(await recheck.evaluate((button, original) => button === original && button.isConnected, originalRecheck), true, 'connection changes preserve the original recheck DOM node');
  await originalRecheck.dispose();
  assert.equal(await page.evaluate(() => window.obsStepsFixture.calls.some(call => call.action === 'launch-obs')), false, 'rechecking never launches OBS or begins a broadcast');
  await page.evaluate(() => { window.obsStepsFixture.holdDiagnose = false; });
}

/** 在三个 CSS 宽度验证布局、输入草稿、键盘、状态轮询和实例路由，不替代真实 OBS 验收。 */
export async function runAcceptance(server) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1280, 780, 520]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port + '/?scenario=unpaired');
      await page.getByRole('heading', { name: '我的 OBS', exact: true }).waitFor();
      const initialTrigger = page.locator('button[id^="obs-step-"][aria-expanded="true"]:visible');
      await expect(initialTrigger).toHaveCount(1);
      const initialId = await initialTrigger.getAttribute('id');
      await page.evaluate(() => { window.obsStepsFixture.setPaired(true); window.obsStepsFixture.setControl('second', false); });
      await page.waitForFunction(() => document.querySelector('#obs-step-2-main')?.textContent.includes('已完成'));
      await expect(page.locator('#' + initialId)).toHaveAttribute('aria-expanded', 'true');
      assert.equal(await page.locator('[data-obs-step-panel]:visible').count(), 1, 'initial default selection survives readiness updates before any manual selection');
      await page.evaluate(() => { window.obsStepsFixture.setPaired(false); window.obsStepsFixture.setControl('second', true); });
      await page.waitForFunction(() => !document.querySelector('#obs-step-2-main')?.textContent.includes('已完成'));
      await selectStep(page, 'main', 2);
      const code = '仅供界面验收的配对码-' + width;
      await page.locator('[data-obs-step-panel]:visible').getByLabel('粘贴配对码').fill(code);
      for (const number of [5, 1, 4, 2]) await selectStep(page, 'main', number);
      assert.equal(await page.locator('[data-obs-step-panel]:visible').getByLabel('粘贴配对码').inputValue(), code, 'pairing draft survives arbitrary step revisit');
      await selectStep(page, 'second', 2);
      assert.equal(await page.locator('[data-obs-step-panel]:visible').getByLabel('粘贴配对码').inputValue(), code, 'computer pairing draft is shared across OBS instances');
      await selectStep(page, 'main', 4, 'Enter');
      await selectStep(page, 'main', 2, 'Space');
      assert.equal(await page.locator('[data-obs-step-panel]:visible').getByLabel('粘贴配对码').inputValue(), code, 'keyboard navigation preserves pairing draft');
      for (const name of ['帮助', '本机 OBS']) {
        await navigate(page, name);
        await navigate(page, '设备配置');
        await selectStep(page, 'main', 2);
        assert.equal(await page.locator('[data-obs-step-panel]:visible').getByLabel('粘贴配对码').inputValue(), code, 'pairing draft survives main-page navigation through ' + name);
      }
      await assertHiddenPanelsAreInert(page);
      await assertVerticalLayout(page, 'main');
      await capture(page, 'pairing-' + width);
      await page.evaluate(() => { window.obsStepsFixture.holdPair = true; });
      await page.getByRole('button', { name: '连接这台电脑', exact: true }).click();
      await page.waitForFunction(() => typeof window.obsStepsFixture.finishPair === 'function');
      await selectStep(page, 'main', 4);
      await expect(page.locator('.setup-feedback:visible').getByRole('status')).toHaveCount(1);
      await page.evaluate(() => window.obsStepsFixture.finishPair());
      await expect(page.getByRole('alert').filter({ hasText: '示例：本次配对未完成' })).toHaveCount(1);
      await expect(page.locator('#obs-step-4-main')).toHaveAttribute('aria-expanded', 'true');
      assert.equal(await page.locator('#obs-step-panel-2-main').getByRole('alert').count(), 0, 'hidden connection panel does not duplicate the visible failure');
      await selectStep(page, 'main', 1);
      const advanced = page.locator('#obs-detail-main details.advanced-settings');
      await advanced.locator('summary').click();
      const draft = 'OBS 1 名称草稿-' + width;
      await page.evaluate(() => { window.obsStepsFixture.rejectRename = true; });
      await advanced.getByRole('textbox').fill(draft);
      await selectStep(page, 'main', 5);
      await page.waitForFunction(() => window.obsStepsFixture.calls.some(call => call.action === 'rename'));
      await selectStep(page, 'second', 1);
      const otherAdvanced = page.locator('#obs-detail-second details.advanced-settings');
      await otherAdvanced.locator('summary').click();
      assert.equal(await otherAdvanced.getByLabel('OBS 2名称', { exact: true }).inputValue(), 'OBS 2', 'unsaved name never appears on another instance');
      await otherAdvanced.getByRole('button', { name: '修正手动 OBS 连接', exact: true }).click();
      await otherAdvanced.getByLabel('端口', { exact: true }).fill('14459');
      await otherAdvanced.getByLabel('WebSocket 密码', { exact: true }).fill('synthetic-manual-draft');
      await selectStep(page, 'second', 4);
      await selectStep(page, 'main', 2);
      await navigate(page, '帮助');
      await navigate(page, '设备配置');
      await selectStep(page, 'second', 1);
      assert.equal(await otherAdvanced.getByLabel('端口', { exact: true }).inputValue(), '14459', 'manual port draft survives steps, instances and main pages');
      assert.equal(await otherAdvanced.getByLabel('WebSocket 密码', { exact: true }).inputValue(), 'synthetic-manual-draft', 'manual password remains only in its mounted form');
      assert.equal(await page.locator('#obs-detail-main input[name="password"]').count(), 0, 'manual connection draft never appears on the managed sibling');
      assert.equal(await page.evaluate(() => window.obsStepsFixture.calls.some(call => call.action === 'repair')), false, 'navigation never submits manual connection drafts');
      await selectStep(page, 'main', 2);
      assert.equal(await advanced.getByRole('textbox').inputValue(), draft, 'rejected name draft survives step and instance changes');
      await selectStep(page, 'main', 1);
      await advanced.locator('summary').click();
      await page.evaluate(() => { window.obsStepsFixture.rejectRename = false; window.obsStepsFixture.setPaired(true); });
      const reads = await page.evaluate(() => window.obsStepsFixture.reads);
      await page.waitForFunction(previous => window.obsStepsFixture.reads > previous, reads);
      await selectStep(page, 'main', 4);
      await page.evaluate(() => window.obsStepsFixture.setControl('main', false));
      const prior = await page.evaluate(() => window.obsStepsFixture.reads);
      await page.waitForFunction(previous => window.obsStepsFixture.reads > previous, prior);
      await expect(page.locator('#obs-step-4-main')).toHaveAttribute('aria-expanded', 'true');
      assert.equal(await page.locator('[data-obs-step-panel]:visible').count(), 1, 'OBS polling does not navigate away from user-selected step');
      await page.evaluate(() => window.obsStepsFixture.setControl('main', true));
      await selectStep(page, 'main', 4);
      await page.getByRole('button', { name: '配置频道 ↗', exact: true }).click();
      await expect(page.getByRole('button', { name: '配置频道 ↗', exact: true })).toBeEnabled();
      await selectStep(page, 'second', 5);
      await page.getByRole('button', { name: '配置素材 ↗', exact: true }).click();
      await expect(page.getByRole('button', { name: '配置素材 ↗', exact: true })).toBeEnabled();
      const routes = await page.evaluate(() => window.obsStepsFixture.calls.filter(call => call.action === 'web'));
      assert.deepEqual(routes, [{ action: 'web', id: 'main' }, { action: 'web', id: 'second' }], 'channel and media links retain their selected instance IDs');
      const renames = await page.evaluate(() => window.obsStepsFixture.calls.filter(call => call.action === 'rename'));
      assert.ok(renames.length > 0 && renames.every(call => call.id === 'main'), 'name drafts save only to their original instance');
      await selectStep(page, 'main', 3);
      await assertVerticalLayout(page, 'main');
      await capture(page, 'connected-' + width);
      await assertHiddenPanelsAreInert(page);
      assert.deepEqual(errors, [], 'rendered application has no uncaught browser errors');
      await page.close();
      const ready = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const readyErrors = []; ready.on('pageerror', error => readyErrors.push(error.message));
      await ready.goto('http://127.0.0.1:' + server.address().port + '/?scenario=ready');
      await ready.locator('#obs-step-panel-3-main:visible').waitFor();
      await expect(ready.locator('#obs-detail-main [data-step-state="complete"]')).toHaveCount(5);
      await assertVerticalLayout(ready, 'main');
      await assertCompactReady(ready, ready.locator('#obs-step-panel-3-main .obs-instance-controls'));
      assert.equal(await ready.locator('.problem-card[role="alert"]:visible,.setup-feedback[role="alert"]:visible,.setup-feedback :is([role="alert"]):visible').count(), 0, 'fresh ready preview contains no product failure card or operation failure feedback');
      assert.equal(await ready.getByRole('alert').filter({ hasText: /示例：|未完成|失败|错误/ }).count(), 0, 'fresh ready preview contains no synthetic or product failure text');
      await capture(ready, 'ready-' + width);
      await assertRecheckFeedback(ready, width === 1280);
      assert.deepEqual(readyErrors, [], 'fresh preview has no browser errors');
      await ready.close();
    }
    console.log('PASS: 1280/780/520 CSS px vertical single-panel steps, keyboard, hidden focus exclusion, retained pairing/name drafts, polling stability, instance-bound actions and recheck running/completion/failure/retry feedback');
    console.log('Screenshots: ' + output);
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createPreviewServer(process.argv.includes('--serve') ? Number(process.env.LIVENEST_STEPS_PORT || 0) : 0);
  if (process.argv.includes('--serve')) {
    console.log('Preview URL: http://127.0.0.1:' + server.address().port + '/?scenario=ready');
    console.log('Pairing preview: http://127.0.0.1:' + server.address().port + '/?scenario=unpaired');
    console.log('示例数据 · 未连接真实 OBS；所有操作仅修改本页内存。关闭此进程即可结束预览。');
    process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
  } else {
    try { await runAcceptance(server); } finally { server.close(); }
  }
}
