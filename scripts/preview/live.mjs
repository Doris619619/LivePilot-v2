/** 在回环地址运行当前网页构建；API 使用正式登录与真实读取，禁止模拟账号、状态及控制成功结果。 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveApi } from './live-api.mjs';
import { PreviewError } from './security.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.LIVENEST_LIVE_PREVIEW_PORT || 63027);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地端口无效。');
const origin = `http://127.0.0.1:${port}`;
const upstream = process.env.LIVENEST_LIVE_ORIGIN || 'https://livenest.duckdns.org';
const liveApi = createLiveApi(upstream, port);
const buildId = (await readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim();
const directory = path.join(repo, '.data/live-preview');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(path.join(directory, 'session-'));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const nextPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const nextOrigin = `http://127.0.0.1:${nextPort}`;
const env = {};
for (const [name, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|temp|tmp|localappdata|appdata|userprofile|programdata|homedrive|homepath|comspec|pathext)$/i.test(name)) env[name] = value;
Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', __NEXT_PROCESSED_ENV: 'true', LIVEPILOT_MODE: 'cloud', LIVEPILOT_ORIGIN: nextOrigin, LIVEPILOT_DATA_ROOT: path.join(root, 'isolated-data'), LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString('hex'), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DEEPSEEK_API_KEY: '' });
const log = await open(path.join(root, 'next.log'), 'a');
const child = spawn(process.execPath, [path.join(repo, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(nextPort)], { cwd: repo, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
await log.close();
let childFailed = false; child.once('error', () => { childFailed = true; });
let server; let closing = false;
const runId = randomUUID();
/** 仅终止本脚本创建的 Next 子进程，不影响其他对话、Agent 或直播。 */
function stop() { if (closing) return; closing = true; child.kill(); server?.close(); setTimeout(() => process.exit(0), 300).unref(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('exit', () => child.kill());
/** 错误仅输出安全的本地提示，不泄露上游凭据或原始网络错误。 */
function errorResponse(response, error) {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(error instanceof PreviewError ? error.status : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: error instanceof PreviewError ? error.message : '无法读取正式服务，请稍后重试。' }));
}
try {
  for (let attempt = 0; ; attempt++) {
    if (childFailed || child.exitCode !== null || attempt >= 100) throw new Error('本地网页构建启动失败。');
    try { if ((await fetch(nextOrigin, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* 等待本脚本拥有的 Next 启动。 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new PreviewError(403, '请从本地预览地址访问。');
      const url = new URL(request.url, origin);
      if (url.origin !== origin || /%|\\/.test(url.pathname)) throw new PreviewError(400, '请求路径无效。');
      if (url.pathname === '/_preview/state' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ synthetic: false, mode: 'live-readonly', upstream, buildId, runId })); return;
      }
      if (url.pathname.startsWith('/api/')) { await liveApi(request, response, url); return; }
      if (!['GET', 'HEAD'].includes(request.method) || url.pathname.startsWith('/_preview/')) throw new PreviewError(405, '不支持此预览操作。');
      const destination = new URL(nextOrigin); destination.pathname = url.pathname; destination.search = url.search;
      const headers = new Headers();
      for (const name of ['accept', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url']) if (request.headers[name]) headers.set(name, String(request.headers[name]));
      const result = await fetch(destination, { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      response.statusCode = result.status;
      for (const [name, value] of result.headers) if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) response.setHeader(name, value);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { errorResponse(response, error); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ synthetic: false, mode: 'live-readonly', upstream, buildId, runId, pid: process.pid, childPid: child.pid, nextPort, url: origin, root }, null, 2));
  console.log(`真实数据预览：${origin}/workspace（使用正式账号登录；仅允许读取）`);
} catch { console.error('真实数据预览未能启动，请检查端口及本地构建。'); stop(); process.exitCode = 1; }
