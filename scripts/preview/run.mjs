/** 仅监听 loopback 的前端验收服务；隔离数据、客户/管理员入口与模拟桌面桥。 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, access, open } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { seed, refresh, control, password, dashboard, agents } from './fixtures.mjs';
import { guardPreview, authorizePreviewControl, previewCookies } from './security.mjs';
import { createPublishingPreview } from './publishing.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
process.chdir(repo);
await access('.next/BUILD_ID'); await access('desktop/out/index.html');
await mkdir('.data/preview', { recursive: true });
const root = await mkdtemp(path.join(repo, '.data/preview/session-'));
await seed(root);
// 仅加载本机显式配置的 DeepSeek 密钥；其他预览配置仍完全隔离。
try { const local = parseEnv(await readFile(path.join(repo, '.env.local'), 'utf8')); if (process.env.LIVENEST_PREVIEW_REAL_AI === '1' && local.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = local.DEEPSEEK_API_KEY; } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地 AI 环境配置'); }
const aiBundle = path.join(root, 'ai-runtime.mjs');
await build({ stdin: { contents: 'export { generateCopy, aiStatus } from "./src/core/broadcast-ai"; export { Store } from "./src/core/storage";', resolveDir: repo, loader: 'ts' }, outfile: aiBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
const ai = await import(pathToFileURL(aiBundle).href);
const aiStore = new ai.Store(path.join(root, 'ai'));
if (process.env.LIVENEST_PREVIEW_REAL_AI !== '1') delete process.env.DEEPSEEK_API_KEY;
let aiBusy = false;
const origin = 'http://127.0.0.1:3022';
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(LIVEPILOT_|GOOGLE_)/.test(name)) delete env[name];
Object.assign(env, { LIVEPILOT_MODE: 'cloud', LIVEPILOT_ORIGIN: origin, LIVEPILOT_DATA_ROOT: root, LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString('hex'), NEXT_TELEMETRY_DISABLED: '1' });
const log = await open(path.join(root, 'web.log'), 'a');
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3022'], { cwd: repo, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
await log.close();
const servers = [];
let timer;
/** 只停止当前预览的子进程和端口，不触碰已安装 App 或其他服务。 */
function stop() { clearInterval(timer); for (const server of servers) server.close(); child.kill(); }
process.once('SIGINT', () => { stop(); process.exit(0); });
process.once('SIGTERM', () => { stop(); process.exit(0); });
process.on('exit', stop);
/** 启动依赖完成后才建立已登录的独立预览入口。 */
async function ready() { for (let n = 0; n < 100; n++) { if (child.exitCode !== null) throw new Error('Local Next server exited; see ' + root); try { if ((await fetch(origin)).ok) return; } catch { /* 等待本次子进程监听。 */ } await new Promise(resolve => setTimeout(resolve, 300)); } throw new Error('Local Next server did not start'); }
/** JSON 错误仅用于本地预览，不转发任意外部 URL。 */
function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
/** 限制前端演示输入体积；大文件上传需要安装版真实环境验收。 */
async function body(request) { let value = ''; for await (const chunk of request) { value += chunk; if (Buffer.byteLength(value) > 3 * 1024 ** 2) throw new Error('本地预览不接收实际素材文件'); } return value; }
/** 每个端口持有独立演示会话，避免客户与管理员标签页相互覆盖角色。 */
async function proxy(port, username) {
  const publishing = createPublishingPreview();
  const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'x-livepilot': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!session.ok) throw new Error('Preview login failed');
  let cookie = previewCookies('', session.headers);
  const server = createServer(async (request, response) => {
    try {
      guardPreview(request, port);
      const url = new URL(request.url, origin);
      if (url.origin !== origin) return json(response, 400, { error: 'Invalid local preview URL' });
      if (url.pathname === '/api/uploads' && request.method === 'GET') {
        await authorizePreviewControl(origin, cookie, { agentId: url.searchParams.get('agentId'), instanceId: url.searchParams.get('instanceId'), action: 'launch' });
        return json(response, 200, []);
      }
      if (/^\/api\/(uploads|youtube)/.test(url.pathname)) return json(response, 409, { error: '本地界面预览：不上传真实素材或连接 YouTube。' });
      const input = ['GET', 'HEAD'].includes(request.method) ? undefined : await body(request);
      if (url.pathname === '/api/live-chat' && request.method === 'POST') {
        const value = JSON.parse(input); await authorizePreviewControl(origin, cookie, { ...value, action: 'launch' });
        if (value.action !== 'read') return json(response, 409, { error: '本地预览只展示合成互动记录，不修改真实聊天配置。' });
        const agent = agents.find(agent => agent.id === value.agentId); const instance = agent.instances.find(instance => instance.id === value.instanceId);
        return json(response, 200, dashboard(agent, instance).liveChat);
      }
      if (url.pathname === '/api/publishing') {
        const inputValue = input ? JSON.parse(input) : undefined;
        await authorizePreviewControl(origin, cookie, { agentId: 'preview_liang', instanceId: 'main', action: 'launch' });
        if (request.method === 'GET') return json(response, 200, publishing.view);
        if (request.method !== 'POST') return json(response, 405, { error: 'Read-only preview' });
        if (inputValue?.agentId && (inputValue.agentId !== 'preview_liang' || inputValue.instanceId !== 'main')) return json(response, 409, { error: '请选择示例发布账号对应的电脑。' });
        try { return json(response, 200, publishing.request(inputValue)); } catch (error) { return json(response, 409, { error: error.message }); }
      }
      if (url.pathname === '/api/broadcast-assets' && request.method === 'POST') {
        const body = JSON.parse(input); await authorizePreviewControl(origin, cookie, { ...body, action: 'launch' });
        if (body.action === 'ai-status') return json(response, 200, await ai.aiStatus(aiStore));
        if (body.action === 'ai-key') return json(response, 409, { error: '本地演示不保存真实 API Key；请在升级后的正式工作台配置。' });
        if (body.action === 'ai-generate' && process.env.DEEPSEEK_API_KEY) {
          if (aiBusy) return json(response, 409, { error: '正在生成文案，请稍候。' });
          aiBusy = true;
          try { return json(response, 200, await ai.generateCopy(aiStore, body.brief)); }
          catch (error) { return json(response, 502, { error: error.code ? error.message : '生成失败，请重试。' }); }
          finally { aiBusy = false; }
        }
        if (body.action === 'ai-generate') return json(response, 200, { demo: true, title: 'Tokyo After Rain | Lofi Beats for Study, Work & Relaxation', description: 'Slow down and find your focus with mellow lofi beats, soft melodies, and a peaceful late-night atmosphere. Let these warm sounds keep you company while you study, work, read, or simply take a quiet break.\n\nSettle into your favorite spot, turn the volume to a comfortable level, and enjoy a little space to breathe.\n\n#lofi #chillbeats #studymusic #relaxingmusic' });
        if (body.action === 'playlists') return json(response, 200, { playlists: [{ id: 'PL_preview_study', title: '学习与专注' }, { id: 'PL_preview_night', title: '深夜电台' }, { id: 'PL_preview_lofi', title: 'Lofi 音乐精选' }] });
        if (body.action === 'thumbnail') return json(response, 200, { id: randomUUID(), name: body.input.name });
        return json(response, 400, { error: '无效演示操作' });
      }
      if (url.pathname === '/api/control' && request.method === 'POST') { const command = JSON.parse(input); const actor = await authorizePreviewControl(origin, cookie, command); return json(response, 200, await control(root, command, actor)); }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value && !['host', 'connection', 'accept-encoding', 'content-length', 'cookie'].includes(key)) headers.set(key, String(value));
      headers.set('Cookie', cookie); if (headers.has('origin')) headers.set('Origin', origin);
      const upstream = await fetch(url, { method: request.method, headers, body: input, redirect: 'manual' });
      if (url.pathname.startsWith('/api/session') && upstream.headers.has('set-cookie')) cookie = previewCookies(cookie, upstream.headers);
      for (const [key, value] of upstream.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) response.setHeader(key, value);
      response.statusCode = upstream.status; response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { json(response, error.status || 500, { error: error.message }); }
  });
  servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}
/** 静态桌面页面仅注入此预览专用桥；路径约束阻止访问仓库与真实数据。 */
async function staticPreview(request, response) {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:3020');
    if (request.method !== 'GET') return json(response, 405, { error: 'Read-only preview assets' });
    let file;
    if (url.pathname === '/') file = path.join(directory, 'index.html');
    else if (url.pathname === '/preview-bridge.js') file = path.join(directory, 'desktop-bridge.js');
    else { const output = path.join(repo, 'desktop/out'); file = path.resolve(output, url.pathname === '/desktop' ? 'index.html' : '.' + decodeURIComponent(url.pathname)); if (!file.startsWith(output + path.sep)) return json(response, 403, { error: 'Invalid preview asset' }); }
    let data = await readFile(file);
    if (url.pathname === '/desktop') data = Buffer.from(data.toString().replace('<head>', '<head><title>LiveNest App · 本地预览</title><script src="/preview-bridge.js"></script>'));
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
    response.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(data);
  } catch { json(response, 404, { error: 'Preview asset not found' }); }
}
try {
  await ready(); await proxy(3021, 'Liang'); await proxy(3023, 'ULiang');
  const server = createServer(staticPreview); servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3020, '127.0.0.1', resolve); });
  let refreshing = false;
  timer = setInterval(async () => { if (refreshing) return; refreshing = true; try { await refresh(root); } catch (error) { console.error(error.message); } finally { refreshing = false; } }, 3000);
  await writeFile('.data/preview/current.json', JSON.stringify({ pid: process.pid, child: child.pid, root, url: 'http://127.0.0.1:3020' }));
  console.log('Local preview ready: http://127.0.0.1:3020');
} catch (error) { console.error(error.message); stop(); process.exitCode = 1; }
