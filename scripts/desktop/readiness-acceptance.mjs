/** 指定 OBS 常驻操作的隔离界面验收，涵盖未配对、控制成功后的入口、目标绑定、运行反馈和窄窗口。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('desktop/out'); const output = path.resolve('docs/desktop/screenshots/obs-guide-019'); await mkdir(output, { recursive: true });
/** 只读取本次构建的静态文件，模拟桥接不访问生产云端。 */
const server = createServer(async (req, res) => {
  try { const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html')); if (!file.startsWith(root + path.sep)) throw Error(); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { version: '0.1.9 模拟', busy: false, dataRoot: 'C:/模拟数据', paired: false, online: false, agentRunning: false, autoStart: false, snapshots: [],
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
  await page.evaluate(() => {}).catch(()=>{});
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('heading',{name:'我的 OBS'}).waitFor();
  for (const name of ['OBS 1','OBS 2']) assert.equal(await page.getByRole('navigation',{name:name+' 配置步骤'}).getByRole('button').count(),5);
  assert.equal(await page.locator('#setup-obs-main').getByText('1 / 5 已完成',{exact:true}).count(),1);
  assert.equal(await page.locator('#setup-obs-second').getByText('2 / 5 已完成',{exact:true}).count(),1);
  assert.equal(await page.locator('.problem-card[role=alert]').count(),0);
  await page.locator('#setup-obs-second').getByRole('button',{name:'继续配置'}).click();
  await page.getByRole('navigation',{name:'OBS 2 配置步骤'}).getByRole('button',{name:/4.*连接频道/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-4-second');
  await page.getByRole('navigation',{name:'OBS 2 配置步骤'}).getByRole('button',{name:/2.*连接网页/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-2-second');
  await page.getByLabel('粘贴配对码').fill('模拟配对码');
  assert.equal(await page.getByRole('button',{name:'连接这台电脑',exact:true}).isEnabled(),true);
  await page.getByRole('navigation',{name:'OBS 1 配置步骤'}).getByRole('button',{name:/1.*准备 OBS/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-1-main');
  assert.deepEqual(await page.locator('#obs-detail-main [id^=obs-step-]').evaluateAll(items=>items.map(e=>e.id)),[1,2,3,4,5].map(n=>'obs-step-'+n+'-main'));
  await page.getByRole('navigation',{name:'OBS 2 配置步骤'}).getByRole('button',{name:/2.*连接网页/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-2-second');
  assert.equal(await page.getByLabel('粘贴配对码').inputValue(),'模拟配对码');
  assert.equal(await page.locator('#obs-detail-main').count(),0);
  console.log('Rendered typography:',await page.locator('.connection-heading p,.pairing-source p,.pairing-submit p,.pairing-form textarea,.setup-progress small').evaluateAll(items=>items.map(e=>({element:e.tagName,size:getComputedStyle(e).fontSize})).slice(-8)));
  await page.getByLabel('粘贴配对码').fill('');
  assert.equal(await page.locator('.problem-card[role=alert]').count(),0);
  assert.equal(await page.getByText('模拟：控制服务已响应，入站隔离待确认。',{exact:true}).isVisible(),false);
  await capture(page,'configuration-780');
  await page.setViewportSize({width:1280,height:900}); await capture(page,'configuration-1280');
  await page.getByRole('button',{name:'启动并检查 OBS 2',exact:true}).click();
  await page.getByText('指定 OBS 已启动并确认控制连接；未执行开播操作',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.launchFixture.calls),[{action:'launch-obs',id:'second'}]);
  await page.getByRole('button',{name:'本机 OBS',exact:true}).click();
  await page.getByRole('button',{name:'配置 OBS 2',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='setup-obs-second');
  await page.evaluate(()=>{window.launchFixture.fail=true;});
  await page.getByRole('button',{name:'启动并检查 OBS 1',exact:true}).focus(); await page.keyboard.press('Enter');
  await page.locator('[data-instance-id="main"]').getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-instance-id="second"]').getByRole('alert').count(),0);
  await capture(page,'blocking-failure');
  await page.evaluate(()=>{window.launchFixture.fail=false;});
  await page.getByRole('button',{name:'重新检查 OBS 1',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.problem-card[role="alert"]'));
  await page.getByRole('button',{name:'添加 OBS',exact:true}).click();
  await page.getByRole('heading',{name:'添加另一个 OBS',exact:true}).waitFor();
  await page.getByRole('button',{name:'添加 OBS',exact:true}).click();
  await page.evaluate(()=>{
    const s=window.launchFixture.state;s.online=true;s.paired=true;s.agentRunning=true;
    s.snapshots=s.instances.map((instance,index)=>({instance,observedAt:Date.now(),dashboard:{busy:false,state:{phase:'idle',stage:'等待',updatedAt:new Date().toISOString()},obs:{ready:true,running:true,streaming:false},youtube:{connected:index===0,channel:index===0?'示例频道':''},media:{videos:index===0?['示例视频.mp4']:[],music:index===0?['示例音乐.mp3']:[]},configuration:{missing:[],privacy:'private',madeForKids:false}}}));
  });
  await page.locator('#setup-obs-main').getByText('准备完成',{exact:true}).waitFor();
  for (const name of ['启动并检查 OBS 2', '重新检查 OBS 2']) assert.equal(await page.locator('#obs-detail-second').getByRole('button', { name, exact: true }).isVisible(), true);
  assert.equal(await page.locator('#setup-obs-main').getByText('5 / 5 已完成',{exact:true}).count(),1);
  assert.equal(await page.locator('#setup-obs-second').getByText('3 / 5 已完成',{exact:true}).count(),1);
  await page.getByRole('navigation',{name:'OBS 1 配置步骤'}).getByRole('button',{name:/2.*连接网页/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-2-main');
  assert.equal(await page.getByLabel('粘贴配对码').count(),0);
  await page.getByRole('navigation',{name:'OBS 2 配置步骤'}).getByRole('button',{name:/4.*连接频道/}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='obs-step-4-second');
  await capture(page,'two-obs-progress-1280');await page.setViewportSize({width:780,height:900});await capture(page,'two-obs-progress-780');
  assert.equal(await page.getByLabel('粘贴配对码').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS independent five-step flows per OBS, shared pairing without repeat, retained pairing input, target navigation, pairing form, target launch, neutral firewall advice, error recovery, keyboard, 780/1280px and centralized addition');
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
