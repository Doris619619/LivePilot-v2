/** 本地预览的合成客户、电脑与心跳；只写入本次新建的隔离目录。 */
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { scryptSync, randomBytes } from 'node:crypto';
import path from 'node:path';
export const password = 'preview123456';
export const agents = [
  { id: 'preview_liang', name: '演示 · Liang 的直播电脑', owner: 'Liang', instances: [{ id: 'main', name: '视频直播' }, { id: 'obs_2', name: '音乐直播' }] },
  { id: 'preview_other', name: '演示 · 第二位客户电脑', owner: 'Demo', instances: [{ id: 'main', name: '演示备用频道' }] },
  { id: 'preview_legacy', name: '演示 · 待分配旧电脑', instances: [{ id: 'main', name: '旧 OBS' }] },
  { id: 'preview_offline', name: '演示 · Kai 的电脑', owner: 'Kai', instances: [{ id: 'main', name: '状态未知' }] },
];
const live = new Set(['preview_liang:main']);
/** 可视化用直播状态，所有频道、素材和时间均为示例，不执行 OBS。 */
export function dashboard(agent, instance) {
  const streaming = live.has(agent.id + ':' + instance.id);
  const error = agent.id === 'preview_other';
  return { busy: false, state: { phase: streaming ? 'live' : 'idle', stage: streaming ? '演示直播中' : '等待开始', updatedAt: new Date().toISOString(), selection: { video: '海边日落.mp4', music: '夜晚钢琴.mp3', videoAudio: false }, ...(streaming ? { startedAt: new Date(Date.now() - 3723000).toISOString() } : {}) },
    obs: { ready: !error, running: true, streaming, durationMs: streaming ? 3723000 : 0, scene: 'LIVE', version: '32.2.2', ...(error ? { message: '演示：OBS WebSocket 密码不匹配，请检查连接设置。' } : {}) },
    youtube: { connected: true, channel: instance.id === 'obs_2' ? '演示 · Calm Piano' : '演示 · Ocean Studio', channelId: 'demo_' + agent.id + '_' + instance.id, lifecycle: streaming ? 'live' : 'complete', ingest: streaming ? 'active' : 'inactive' },
    media: { videos: ['海边日落.mp4', '雨夜城市.mp4', '山间云海.mp4'], music: ['夜晚钢琴.mp3', '轻柔爵士.mp3'] }, configuration: { missing: [], privacy: 'unlisted', madeForKids: false } };
}
/** 原子替换演示心跳，避免预览刷新恰好读到半个 JSON。 */
async function json(filename, value) { await mkdir(path.dirname(filename), { recursive: true }); const temp = filename + '.' + randomBytes(8).toString('hex') + '.tmp'; await writeFile(temp, JSON.stringify(value)); await rename(temp, filename); }
/** 初始化仅用于本地的账号；这些合成密码与线上账号无关。 */
export async function seed(root) {
  const salt = randomBytes(16).toString('hex'); const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  await json(path.join(root, 'access/access.json'), { users: [['Do', 'admin'], ['ULiang', 'admin'], ['UDo', 'admin'], ['Liang', 'customer'], ['Demo', 'customer'], ['Kai', 'customer']].map(([username, role]) => ({ username, role, salt, hash, revision: 'local-preview', disabled: false })), sessions: {}, attempts: {} });
  await json(path.join(root, 'cloud/agents.json'), { agents: agents.map(a => ({ ...a, revoked: false, session: 'preview', tokenHash: randomBytes(32).toString('hex') })) });
  await refresh(root);
}
/** 持续保留在线、离线和异常示例；不改动用户在本地预览中分配的归属。 */
export async function refresh(root) { for (const a of agents) { const at = Date.now() - (a.id === 'preview_offline' ? 120000 : 0); await json(path.join(root, 'cloud/agents', a.id, 'heartbeat.json'), { at, session: 'preview', snapshots: a.instances.map(i => ({ instance: i, observedAt: at, dashboard: dashboard(a, i) })) }); } }
/** 本地代理截获开停播按钮，只改变示例状态，不派发真实任务。 */
export async function control(root, body, actor) { const key = body.agentId + ':' + body.instanceId; if (body.action === 'start') live.add(key); if (body.action === 'stop') live.delete(key); await refresh(root); return { operation: { id: randomBytes(8).toString('hex'), actor, action: body.action, status: 'succeeded', updatedAt: new Date().toISOString(), message: '仅更新本地演示状态' } }; }
