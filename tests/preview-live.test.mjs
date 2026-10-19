/** 验证真实数据预览的来源、会话隔离和禁止生产写入边界；不访问真实账号或设备。 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { allowedLiveRequest, createLiveApi } from '../scripts/preview/live-api.mjs';

/** 构造回环同源请求与响应收集器，不生成业务数据或真实凭据。 */
function exchange(method, cookie = '', body, origin = 'http://127.0.0.1:63027') {
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(request, { method, headers: { host: '127.0.0.1:63027', origin, cookie, 'x-livepilot': '1', 'x-livepilot-user': 'Liang', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } });
  const response = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.body = value.toString(); } };
  return { request, response };
}

describe('live data preview', () => {
  it('allows only explicit reads and normal session management', () => {
    expect(allowedLiveRequest('GET', '/api/status')).toBe(true);
    expect(allowedLiveRequest('POST', '/api/live-chat', { action: 'read' })).toBe(true);
    for (const action of ['start', 'stop', 'configure', 'preview', 'ai-generate']) {
      for (const route of ['/api/control', '/api/live-chat', '/api/broadcast-assets']) expect(allowedLiveRequest('POST', route, { action })).toBe(false);
    }
    expect(allowedLiveRequest('POST', '/api/broadcast-profiles', { action: 'save' })).toBe(false);
    expect(allowedLiveRequest('GET', '/api/youtube/connect')).toBe(false);
    expect(allowedLiveRequest('GET', '/api/status/../control')).toBe(false);
  });
  it('preserves actual API bytes, status and queries without fixture labels', async () => {
    const payload = '{"agents":[],"instances":[]}';
    const upstream = vi.fn(async () => new Response(payload, { status: 200 }));
    const api = createLiveApi('https://example.com', 63027, upstream);
    const { request, response } = exchange('GET');
    await api(request, response, new URL('http://127.0.0.1:63027/api/instances?customer=Liang'));
    expect(response.body).toBe(payload);
    expect(upstream.mock.calls[0][0].href).toBe('https://example.com/api/instances?customer=Liang');
    expect(response.status).toBe(200);
  });
  it('keeps production cookies server-side and isolates different browsers', async () => {
    const upstream = vi.fn(async () => new Response('{"user":{"username":"Liang"}}', { headers: { 'Set-Cookie': 'livepilot_session=test-only-upstream-token; HttpOnly; Secure; Path=/' } }));
    const api = createLiveApi('https://example.com', 63027, upstream);
    const first = exchange('POST', '', { username: 'Liang', password: 'test-only-password' });
    await api(first.request, first.response, new URL('http://127.0.0.1:63027/api/session'));
    const local = first.response.headers['set-cookie'];
    expect(local).toContain('HttpOnly; SameSite=Strict');
    expect(local).not.toContain('test-only-upstream-token');
    const next = exchange('GET', local.split(';')[0]);
    await api(next.request, next.response, new URL('http://127.0.0.1:63027/api/status'));
    expect(upstream.mock.calls[1][1].headers.get('cookie')).toBe('livepilot_session=test-only-upstream-token');
    expect(upstream.mock.calls[1][1].headers.get('x-livepilot-user')).toBe('Liang');
    const other = exchange('GET');
    await api(other.request, other.response, new URL('http://127.0.0.1:63027/api/status'));
    expect(upstream.mock.calls[2][1].headers.get('cookie')).toBeNull();
  });
  it('rejects cross-origin requests and control writes before contacting upstream', async () => {
    const upstream = vi.fn(); const api = createLiveApi('https://example.com', 63027, upstream);
    const cross = exchange('POST', '', { username: 'Liang' }, 'https://evil.example');
    await expect(api(cross.request, cross.response, new URL('http://127.0.0.1:63027/api/session'))).rejects.toMatchObject({ status: 403 });
    const write = exchange('POST', '', { action: 'stop' });
    await expect(api(write.request, write.response, new URL('http://127.0.0.1:63027/api/control'))).rejects.toMatchObject({ status: 403 });
    expect(upstream).not.toHaveBeenCalled();
  });
  it('returns real authentication errors and refuses unexpected redirects', async () => {
    const upstream = vi.fn(async () => new Response('{"error":"请登录后继续。"}', { status: 401 }));
    const api = createLiveApi('https://example.com', 63027, upstream);
    const read = exchange('GET');
    await api(read.request, read.response, new URL('http://127.0.0.1:63027/api/session'));
    expect(read.response.status).toBe(401);
    expect(read.response.body).toBe('{"error":"请登录后继续。"}');
    upstream.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }));
    const redirect = exchange('GET');
    await expect(api(redirect.request, redirect.response, new URL('http://127.0.0.1:63027/api/session'))).rejects.toMatchObject({ status: 502 });
  });
  it('requires a fixed HTTPS origin without credentials or a path', () => {
    for (const invalid of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?q=x']) expect(() => createLiveApi(invalid, 63027)).toThrow();
  });
});
