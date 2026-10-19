/** 本地网页验收代理：转发正式账号的只读接口，生产会话仅存在进程内存，不生成演示数据。 */
import { randomBytes } from 'node:crypto';
import { guardPreview, PreviewError, previewCookies } from './security.mjs';

const reads = new Set(['/api/session', '/api/session/accounts', '/api/instances', '/api/status', '/api/broadcast-profiles', '/api/broadcast-defaults', '/api/account-ai', '/api/uploads', '/api/admin/overview']);
const localCookie = 'livenest_live_preview';
const lifetime = 12 * 60 * 60 * 1000;

/** 明确列出允许的读取与登录动作；任何开停播、配置写入、上传及付费生成均不会送到正式服务。 */
export function allowedLiveRequest(method, pathname, body) {
  if (method === 'GET') return reads.has(pathname);
  if (pathname === '/api/session') return method === 'POST' || method === 'DELETE';
  if (pathname === '/api/session/accounts') return method === 'POST';
  if (method !== 'POST') return false;
  if (pathname === '/api/live-chat') return body?.action === 'read';
  return pathname === '/api/broadcast-assets' && ['ai-status', 'playlists'].includes(body?.action);
}

/** 创建每浏览器独立的内存会话；保留上游响应内容和错误，不转发生产 Cookie 给本地浏览器。 */
export function createLiveApi(upstream, port, requestUpstream = fetch) {
  const origin = new URL(upstream);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('正式服务地址必须是无凭据的 HTTPS Origin。');
  const sessions = new Map();
  return async function liveApi(request, response, url) {
    guardPreview(request, port);
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new PreviewError(403, '只允许本机访问。');
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32 * 1024) throw new PreviewError(413, '请求过大。');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    let body;
    try { body = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined; }
    catch { throw new PreviewError(400, '请求格式无效。'); }
    if (!allowedLiveRequest(request.method, url.pathname, body)) throw new PreviewError(403, '本地验收仅允许读取真实数据；请到正式工作台执行此操作。');
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(localCookie + '='))?.slice(localCookie.length + 1);
    let session = sessions.get(token);
    if (!session) {
      if (sessions.size >= 100) throw new PreviewError(503, '本地会话过多，请重启预览。');
      session = { token: randomBytes(32).toString('hex'), cookie: '', expires: Date.now() + lifetime };
      sessions.set(session.token, session);
      response.setHeader('Set-Cookie', `${localCookie}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}`);
    }
    const headers = new Headers({ accept: 'application/json', origin: origin.origin, 'x-livepilot': '1', 'sec-fetch-site': 'same-origin' });
    if (session.cookie) headers.set('cookie', session.cookie);
    if (request.headers['x-livepilot-user']) headers.set('x-livepilot-user', String(request.headers['x-livepilot-user']));
    if (bytes.length) headers.set('content-type', 'application/json');
    const destination = new URL(origin.origin); destination.pathname = url.pathname; destination.search = url.search;
    const result = await requestUpstream(destination, { method: request.method, headers, body: bytes.length ? bytes : undefined, redirect: 'manual', signal: AbortSignal.timeout(65_000) });
    if (result.status >= 300 && result.status < 400) throw new PreviewError(502, '正式接口返回了意外跳转。');
    session.cookie = previewCookies(session.cookie, result.headers);
    response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
