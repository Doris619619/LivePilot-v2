/** 本地模拟控制必须执行与生产相同的来源、会话和归属检查。 */
import { describe, expect, it, vi } from 'vitest';
import { guardPreview, authorizePreviewControl } from '../scripts/preview/security.mjs';
const origin = 'http://127.0.0.1:3022';
const command = { agentId: 'a', instanceId: 'main', action: 'stop' };
/** 上游读取替身只返回合成角色与设备，不执行网络或直播。 */
function upstream(user, agents, status = 200) {
  return vi.fn().mockResolvedValueOnce(Response.json({ user }, { status })).mockResolvedValueOnce(Response.json({ agents }));
}
const agent = { id: 'a', owner: 'Liang', online: true, instances: [{ id: 'main' }] };
describe('preview security', () => {
  it('rejects foreign origins, missing write guard and forged hosts', () => {
    const headers = { host: '127.0.0.1:3021', origin: 'http://127.0.0.1:3021', 'x-livepilot': '1' };
    expect(() => guardPreview({ method: 'POST', headers }, 3021)).not.toThrow();
    for (const override of [{ origin: 'https://foreign.example' }, { origin: undefined }, { host: 'foreign.example' }, { 'x-livepilot': undefined }, { 'sec-fetch-site': 'cross-site' }]) expect(() => guardPreview({ method: 'POST', headers: { ...headers, ...override } }, 3021)).toThrow();
    expect(() => guardPreview({ method: 'GET', headers: { host: headers.host } }, 3021)).not.toThrow();
  });
  it('denies logged out sessions and cross-customer targets', async () => {
    await expect(authorizePreviewControl(origin, '', command, upstream(undefined, [], 401))).rejects.toMatchObject({ status: 401 });
    await expect(authorizePreviewControl(origin, 'synthetic', command, upstream({ username: 'Other', role: 'customer' }, [agent]))).rejects.toMatchObject({ status: 403 });
    await expect(authorizePreviewControl(origin, 'synthetic', command, upstream({ username: 'Liang', role: 'customer' }, []))).rejects.toMatchObject({ status: 403 });
  });
  it('returns the current account as actor, including administrator assistance', async () => {
    expect(await authorizePreviewControl(origin, 'synthetic', command, upstream({ username: 'Liang', role: 'customer' }, [agent]))).toBe('Liang');
    expect(await authorizePreviewControl(origin, 'synthetic', command, upstream({ username: 'UDo', role: 'admin' }, [agent]))).toBe('UDo');
  });
  it('rejects removed, offline and nonexistent OBS targets', async () => {
    for (const [changed, status] of [[{ revoked: true }, 403], [{ pairedTo: 'new' }, 403], [{ online: false }, 503], [{ instances: [] }, 403]]) await expect(authorizePreviewControl(origin, 'synthetic', command, upstream({ username: 'UDo', role: 'admin' }, [{ ...agent, ...changed }]))).rejects.toMatchObject({ status });
  });
});
