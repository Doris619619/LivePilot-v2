/** 文件用途：在真实 React/Edge 和纯本地合成接口中验证失败草稿不回滚、冻结场次不被改写；不发送直播命令。 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(tmpdir(), 'livenest-recovery-ui-'));
let phase = 'stopped'; let frozen = false; let writes = 0;
const entry = `import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {useInstance} from './src/app/use-instance';function App(){const m=useInstance({id:'main',name:'Synthetic OBS'});useEffect(()=>{window.auditModel=m;});return React.createElement('select',{id:'video',value:m.selection.video,disabled:m.locked,onChange:e=>m.select({video:e.target.value})},React.createElement('option',{value:'first.mp4'},'First'),React.createElement('option',{value:'second.mp4'},'Second'));}createRoot(document.getElementById('root')).render(React.createElement(App));`;
await build({ stdin: { contents: entry, sourcefile: 'recovery-entry.tsx', resolveDir: repo, loader: 'tsx' }, outfile: path.join(directory, 'app.js'), bundle: true, platform: 'browser', format: 'iife', alias: { '@': path.join(repo, 'src') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const asset = await readFile(path.join(directory, 'app.js'));

/** 每次读取都来自当前合成场次；禁止将此测试连接到任何真实设备或外部平台。 */
function dashboard() {
  return { busy: false, state: { phase, stage: 'Synthetic only', updatedAt: new Date().toISOString(), selection: { video: 'first.mp4', music: 'first.mp3', videoAudio: false, broadcast: { title: 'Synthetic', description: '', privacy: 'private', madeForKids: false, playlistIds: [] } }, ...(frozen ? { broadcastId: 'existing', broadcastTitle: 'Existing synthetic session' } : {}) }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true, query: 'ready', lifecycle: phase === 'stopped' ? 'complete' : 'ready' }, media: { videos: ['first.mp4', 'second.mp4'], music: ['first.mp3'] }, configuration: { missing: [], privacy: 'private', madeForKids: false } };
}
/** 仅返回本次内存中的状态；任何写请求均拒绝并计数，断言测试没有开停播副作用。 */
const server = createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { writes++; response.writeHead(409); response.end(); return; }
  if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><div id="root"></div><script src="/app.js"></script>'); }
  else if (request.url === '/app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(asset); }
  else if (request.url?.startsWith('/api/status')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(dashboard())); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const scenario of [{ phase: 'stopped', frozen: false }, { phase: 'error', frozen: false }, { phase: 'error', frozen: true }]) {
    phase = scenario.phase; frozen = scenario.frozen;
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin); await page.waitForFunction(() => window.auditModel?.data);
    if (frozen) {
      assert.equal(await page.locator('#video').isDisabled(), true);
      assert.equal(await page.inputValue('#video'), 'first.mp4');
    } else {
      await page.selectOption('#video', 'second.mp4');
      await page.waitForFunction(() => window.auditModel.selection.video === 'second.mp4');
      for (let count = 0; count < 3; count++) await page.evaluate(async () => { await window.auditModel.refresh(); });
      assert.equal(await page.inputValue('#video'), 'second.mp4');
      assert.equal(await page.locator('#video').isEnabled(), true);
      await page.reload(); await page.waitForFunction(() => window.auditModel?.data);
      assert.equal(await page.inputValue('#video'), 'second.mp4');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scenario, result: 'passed', video: await page.inputValue('#video') }));
    await page.close();
  }
  assert.equal(writes, 0);
  console.log('3 browser scenarios passed; no control commands or external requests.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  const relative = path.relative(tmpdir(), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('livenest-recovery-ui-')) throw new Error('Refusing cleanup outside the owned temporary directory');
  await rm(directory, { recursive: true, force: true });
}
