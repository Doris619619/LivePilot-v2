/** 预览代理保留同源、会话和设备归属边界，模拟操作不能绕过真实读取权限。 */
export class PreviewError extends Error {
  /** 状态码用于本机 HTTP 响应，消息不包含凭据。 */
  constructor(status, message) { super(message); this.status = status; }
}
/** 保留多账号登录返回的全部 Cookie；只处理本机预览内存，不写入浏览器或日志。 */
export function previewCookies(previous, headers) {
  const values = new Map(previous.split(';').map(value => value.trim()).filter(Boolean).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
  for (const item of headers.getSetCookie()) {
    const pair = item.split(';')[0]; const index = pair.indexOf('='); const name = pair.slice(0, index); const value = pair.slice(index + 1);
    if (!value || /Max-Age=0(?:;|$)/i.test(item)) values.delete(name); else values.set(name, value);
  }
  return [...values].map(([name, value]) => name + '=' + value).join('; ');
}
/** 在改写上游 Origin 之前校验浏览器的原始来源。 */
export function guardPreview(request, port) {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const mutation = !['GET', 'HEAD'].includes(request.method);
  if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin) || (mutation && (request.headers.origin !== origin || request.headers['x-livepilot'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site'))) {
    throw new PreviewError(403, '请从本地预览页面发起操作。');
  }
}
/** 真实服务确认当前账号与可见实例，返回真实操作人后才允许改变合成状态。 */
export async function authorizePreviewControl(origin, cookie, input, request = fetch) {
  const session = await request(origin + '/api/session', { headers: { Cookie: cookie } });
  if (!session.ok) throw new PreviewError(session.status, '请重新登录本地预览。');
  const { user } = await session.json();
  if (!input || !['start', 'stop', 'launch', 'clear-uncertain'].includes(input.action) || typeof input.agentId !== 'string' || typeof input.instanceId !== 'string') throw new PreviewError(400, '请选择有效电脑、OBS 和操作。');
  const response = await request(origin + '/api/instances', { headers: { Cookie: cookie } });
  if (!response.ok) throw new PreviewError(response.status, '无法确认本地预览设备权限。');
  const catalog = await response.json();
  const agent = catalog.agents?.find(a => a.id === input.agentId && !a.revoked && !a.pairedTo);
  if (!agent || (user.role !== 'admin' && agent.owner !== user.username) || !agent.instances.some(i => i.id === input.instanceId)) throw new PreviewError(403, '无权操作此电脑或 OBS。');
  if (!agent.online) throw new PreviewError(503, '电脑离线，不能提交新的演示操作。');
  return user.username;
}
