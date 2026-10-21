/** 真实 React/Edge 合成桌面回归：名称、手动连接、退休确认与断网本机停止；不使用真实桌面桥接。 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'ln-desktop-recovery-ui-'));
const screenshots = path.join(repo, 'docs/images/desktop-recovery');
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import Page from './desktop/app/page';import {makeProblem} from './src/shared/problems';import './src/app/globals.css';import './src/app/login.css';import './desktop/app/desktop.css';import './src/app/components/ui/ui.css';
const instances=[{id:'main',name:'Synthetic Main',managed:false,exe:'C:\\\\Synthetic\\\\obs64.exe',port:4455,initialized:true},{id:'obs_second',name:'Synthetic Second',managed:true,exe:'C:\\\\Synthetic2\\\\obs64.exe',port:4456,initialized:true}];
const state={version:'synthetic-test',dataLocationReady:true,dataRoot:'C:\\\\SyntheticData',paired:true,agentId:'synthetic',agentRunning:true,online:true,autoStart:false,busy:false,instances,candidates:[],archivedCandidates:[],checks:[],snapshots:[],update:{status:'idle',message:'合成测试'}};
window.auditActions=[];window.renameFail=true;window.auditState=state;window.offline=false;window.localRead=true;
window.liveNest={session:async()=>({authenticated:true,username:'Synthetic tester'}),state:async()=>state,readState:async()=>window.offline?{ok:false,problem:makeProblem('CLOUD_NETWORK','合成 Cloud 网络中断。'),...(window.localRead?{localState:state}:{})}:{ok:true,state},updateState:async()=>({version:state.version,busy:false,update:state.update}),act:async(action,input)=>{window.auditActions.push({action,input});if(action==='rename'&&window.renameFail)return {ok:false,problem:makeProblem('STORAGE_PERMISSION','合成保存失败，请重试。',{target:{instanceId:input.id}})};if(action==='rename')instances.find(i=>i.id===input.id).name=input.name;return {ok:true,state};}};createRoot(document.getElementById('root')).render(<Page/>);`;
await build({ stdin: { contents: entry, sourcefile: 'desktop-recovery-entry.tsx', resolveDir: repo, loader: 'tsx' }, outfile: path.join(temporary, 'app.js'), bundle: true, platform: 'browser', format: 'iife', alias: { '@': path.join(repo, 'src') }, define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const script = await readFile(path.join(temporary, 'app.js')); const css = await readFile(path.join(temporary, 'app.css')); const font = await readFile(path.join(repo, 'src/app/fonts/livenest-sans-sc.woff2'));
/** 此 HTTP 服务只提供合成页面和已打包静态资源，所有外部请求在浏览器中拒绝。 */
const server = createServer((request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>@font-face{font-family:LiveNestFixture;src:url(/font.woff2)}body{--font-livenest:LiveNestFixture}</style><p style="margin:8px 24px">合成桌面数据 · 不连接真实设备</p><div id="root"></div><script src="/app.js"></script>'); }
  else if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end(script); }
  else if (request.url === '/font.woff2') { response.setHeader('content-type', 'font/woff2'); response.end(font); }
  else if (request.url === '/app.css') { response.setHeader('content-type', 'text/css'); response.end(css); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port; let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 880 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort()); await page.goto(origin);
  await page.waitForSelector('#setup-obs-main', {timeout:5000}).catch(async error => {console.error(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error;});
  const main = page.locator('#setup-obs-main'); await main.locator('.advanced-settings > summary').click();
  let name = main.getByRole('textbox', { name: 'Synthetic Main名称' }); await name.fill('Unsaved name'); await page.getByRole('heading', { name: '设备配置', exact: true }).click();
  await page.waitForFunction(() => window.auditActions.some(item => item.action === 'rename')); await page.waitForFunction(() => document.querySelector('#setup-obs-main input[aria-label$="名称"]').value === 'Synthetic Main');
  await page.evaluate(() => { window.renameFail = false; }); await name.fill('Saved name'); await page.getByRole('heading', { name: '设备配置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#setup-obs-main input[aria-label$="名称"]').value === 'Saved name');
  await main.getByRole('button', { name: '修正手动 OBS 连接' }).click(); await main.locator('input[name="port"]').fill('4460'); await main.locator('input[name="password"]').fill('synthetic-only'); await main.getByRole('button', { name: '保存并检查' }).click();
  await page.waitForFunction(() => window.auditActions.some(item => item.action === 'repair' && item.input.id === 'main' && item.input.port === 4460));
  const second = page.locator('#setup-obs-obs_second'); await second.getByRole('button', { name: /继续配置|查看配置/ }).click(); await second.locator('.advanced-settings > summary').click(); await second.getByText('退役此 OBS', { exact: true }).click();
  assert.equal(await second.getByRole('button', { name: '确认退役' }).isDisabled(), true); await second.getByRole('checkbox').check(); await second.getByRole('button', { name: '确认退役' }).click();
  await page.waitForFunction(() => window.auditActions.some(item => item.action === 'retire' && item.input.confirmed === true));
  await mkdir(screenshots, { recursive: true });
  for (const width of [1280, 780]) { await page.setViewportSize({ width, height: 880 }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(screenshots, 'synthetic-' + width + '.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
  // 页面先读取没有推流的快照；Cloud 失败后宿主才带回最新本机推流证据，两个页面均须提供同一停止入口。
  await page.evaluate(() => { window.offline = true; window.auditState.snapshots = [{ instance: { id: 'main', name: 'Saved name' }, observedAt: Date.now(), dashboard: { state: { phase: 'live', obsStartRequested: true }, obs: { streaming: true, ready: true, running: true }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [] } } }]; });
  await page.getByRole('button', { name: '重新读取', exact: true }).click(); await page.getByRole('button', { name: /本机停止推流/ }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'synthetic-offline-stop.png'), fullPage: true });
  await page.getByRole('button', { name: '本机 OBS', exact: true }).click(); await page.getByRole('button', { name: /本机停止推流/ }).waitFor();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: /本机停止推流/ }).click();
  await page.waitForFunction(() => window.auditActions.some(item => item.action === 'stop-local' && item.input.id === 'main'));
  await page.evaluate(() => { window.localRead = false; });
  await page.getByRole('button', { name: '设备配置', exact: true }).click(); await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('本机停止推流')));
  await page.evaluate(() => { window.localRead = true; window.auditState.snapshots[0].dashboard.state.obsStartRequested = false; });
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes('合成 Cloud 网络中断。'));
  assert.equal(await page.getByRole('button', { name: /本机停止推流/ }).count(), 0);
  await page.evaluate(() => { window.auditState.snapshots[0].dashboard.state.obsStartRequested = true; });
  await page.evaluate(() => { window.offline = false; }); await page.getByRole('button', { name: '重新读取', exact: true }).click(); await page.getByRole('button', { name: '本机 OBS', exact: true }).click();
  await page.getByRole('button', { name: /本机停止推流/ }).waitFor();
  assert.deepEqual(errors, []); console.log('9 synthetic desktop browser scenarios passed at 1280/780px, including authorized offline stop, denied-local-read recovery and foreign stream refusal; no external requests or native OBS actions.');
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(temporary) !== tmpdir() || !path.basename(temporary).startsWith('ln-desktop-recovery-ui-')) throw new Error('Unsafe cleanup');
  await rm(temporary, { recursive: true, force: true });
}
