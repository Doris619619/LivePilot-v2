/** 指定 OBS 启动按钮的隔离界面验收，涵盖未配对、目标绑定、运行反馈和窄窗口。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('desktop/out'); const output = path.resolve('docs/desktop/screenshots/launch'); await mkdir(output, { recursive: true });
/** 只读取本次构建的静态文件，模拟桥接不访问生产云端。 */
const server = createServer(async (req, res) => {
  try { const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html')); if (!file.startsWith(root + path.sep)) throw Error(); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { version: '0.1.7 模拟', busy: false, dataRoot: 'C:/模拟数据', paired: false, online: false, agentRunning: false, autoStart: false, snapshots: [],
      instances: [{ id: 'main', name: 'OBS 1', initialized: true, managed: true }, { id: 'second', name: 'OBS 2', initialized: true, managed: true }],
      checks: [{ id: 'network-main', instanceId: 'main', label: 'OBS 1', status: 'pending', code: 'not-running', controlReady: false, checkedAt: Date.now() }, { id: 'network-second', instanceId: 'second', label: 'OBS 2', status: 'error', code: 'firewall-unconfirmed', message: '模拟：控制服务已响应，入站隔离待确认。', controlReady: true, checkedAt: Date.now() }], update: { status: 'idle' } };
    const fixture = window.launchFixture = { calls: [], fail: false, state };
    window.liveNest = { session: async () => ({ authenticated: true, username: '模拟客户' }), logout: async () => {}, readState: async () => ({ ok: true, state }), updateState: async () => state,
      act: async (action, input) => { fixture.calls.push({ action, ...input }); await new Promise(resolve => setTimeout(resolve, 650));
        if (fixture.fail) return { ok: false, problem: { version: 1, source: 'desktop', code: 'OBS_PORT', domain: 'obs', target: { instanceId: input.id }, severity: 'error', stage: '启动 OBS 1', outcome: 'rejected', observedAt: Date.now(), actions: ['settings', 'refresh'], message: '模拟故障：OBS 1 端口被其他程序占用。' } };
        if (action === 'launch-obs') { state.activity = { action, instanceId: input.id, step: 2, status: 'complete', stage: '指定 OBS 已启动并确认控制连接；未执行开播操作', startedAt: Date.now() }; Object.assign(state.checks.find(c => c.instanceId === input.id), { status: 'ready', controlReady: true, code: undefined, checkedAt: Date.now() }); }
        if (action === 'add') state.instances.push({ id: 'second', name: 'OBS 2', initialized: true, managed: true });
        return { ok: true, state };
      } };
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).waitFor();
  assert.equal(await page.locator('[data-instance-id="second"]').getByText('控制已连接（上次检查）', { exact: true }).count(), 1);
  for (const name of ['OBS 1', 'OBS 2']) assert.equal(await page.getByRole('button', { name: '启动并检查 ' + name, exact: true }).evaluate(el => !!el.closest('details')), false);
  await capture(page, 'setup-780');
  const start = page.getByRole('button', { name: '启动并检查 OBS 2', exact: true }); await start.click();
  assert.equal(await start.isDisabled(), true); await page.getByText('指定 OBS 已启动并确认控制连接；未执行开播操作', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.launchFixture.calls), [{ action: 'launch-obs', id: 'second' }]);
  await page.getByRole('button', { name: '本机 OBS', exact: true }).click();
  await page.getByRole('button', { name: '重新检查 OBS 2', exact: true }).click();
  await page.waitForFunction(() => window.launchFixture.calls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.launchFixture.calls[1]), { action: 'diagnose-obs', id: 'second' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="启动并检查 OBS 1"]').disabled);
  await page.evaluate(() => { window.launchFixture.fail = true; });
  await page.getByRole('button', { name: '启动并检查 OBS 1', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator('[data-instance-id="main"]').getByText('模拟故障：OBS 1 端口被其他程序占用。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-instance-id="second"]').getByText('模拟故障：OBS 1 端口被其他程序占用。', { exact: true }).count(), 0);
  await capture(page, 'failure-780'); await page.setViewportSize({ width: 1280, height: 900 }); await capture(page, 'failure-1280');
  // 日常页不能另有一套新增流程；返回配置定位原实例，第二个 OBS 在同一入口添加。
  assert.equal(await page.getByRole('button', { name: '+ 添加 OBS', exact: true }).count(), 0);
  await page.getByRole('button', { name: '配置 OBS 2', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'setup-obs-second');
  await page.evaluate(() => { const f=window.launchFixture; f.fail=false; f.state.instances.pop(); f.state.paired=true; delete f.state.activity; });
  const add=page.getByRole('button',{name:'+ 添加第二个 OBS',exact:true}); await add.waitFor();
  await capture(page,'add-second-1280'); await add.click();
  await page.getByRole('heading',{name:'OBS 2',exact:true}).waitFor();
  await page.getByRole('button',{name:'配置 OBS 2 的频道和素材 ↗',exact:true}).click();
  await page.waitForFunction(()=>window.launchFixture.calls.at(-1)?.action==='web');
  assert.deepEqual(await page.evaluate(()=>window.launchFixture.calls.slice(-2)),[{action:'add'},{action:'web',id:'second'}]);
  await page.waitForFunction(() => !document.querySelector('[aria-label="启动并检查 OBS 1"]').disabled);
  await capture(page,'configured-two-1280');
  await page.evaluate(()=>{window.launchFixture.state.candidates=[{id:'third',name:'OBS 3',managed:true}];});
  await page.getByText('OBS 3 尚未配置完成，请先在上方重试配置或撤销新增，再添加其他 OBS。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'+ 添加 OBS',exact:true}).isDisabled(),true);
  assert.deepEqual(errors, []); console.log('PASS OBS UI: visible target buttons, unpaired verified control, disabled duplicate input, target-bound failure, keyboard, 780/1280px');
} finally { await browser.close(); server.close(); }
/** 验收截图明确为模拟数据，并检查页面和按钮尺寸。 */
async function capture(page, name) {
  await page.evaluate(() => { if (!document.getElementById('fixture-note')) { const note = document.createElement('div'); note.id = 'fixture-note'; note.textContent = '模拟故障 / 隔离界面验收 · 未启动真实 OBS 或开播'; note.style.cssText = 'padding:8px;background:#254131;color:white'; document.body.prepend(note); } });
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.main-wrapper')?.scrollTo(0, 0); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const button of await page.getByRole('button', { name: /^启动并检查 OBS/ }).all()) assert.ok((await button.boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
