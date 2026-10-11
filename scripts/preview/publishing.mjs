/** 本地发布界面的合成数据；不调用 Agent、YouTube 或文件上传，编辑仅存在本次进程内。 */
import { randomUUID } from 'node:crypto';

/** 构造当前月份的独立草稿与已确认批次，方便检查月历、表格、详情抽屉及进度。 */
export function createPublishingPreview() {
  const now = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const account = { id: randomUUID(), agentId: 'preview_liang', instanceId: 'main', name: '演示发布账号', owner: 'Liang', status: 'connected', channelId: 'demo_ocean', channel: '演示 · Ocean Studio', channelCheckedAt: now, createdAt: now, updatedAt: now, connectedAt: now };
  const policy = { enabled: true, publicVerified: true, projectKey: 'preview', uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: '', verificationNote: '' };
  const profile = { id: randomUUID(), revision: 1, name: '每周音乐精选', agentId: account.agentId, instanceId: account.instanceId, accountId: account.id, channelId: account.channelId, titleTemplate: '{filename}', descriptionTemplate: '演示 · 安静的音乐时刻', tags: ['music', 'lofi'], categoryId: '10', playlistIds: [], privacy: 'public', scheduled: true, madeForKids: false, license: 'youtube', embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: 'none', ai: { enabled: false, language: '中文', prompt: '描述音乐场景', fallbackTitle: '{filename}', fallbackDescription: '' }, schedule: { timezone: 'Asia/Shanghai', weekdays: [1, 3, 5], localTime: '18:00', startDate: today, preuploadDays: 28 } };
  const names = ['海边日落', '东京雨夜', '山间云海', '午后咖啡', '深夜电台', '周末钢琴'];
  const batch = { id: 'a'.repeat(64), name: '演示 · 十月音乐集', version: 'b'.repeat(64), issues: [], packages: names.map((name, index) => { const id = (index + 1).toString(16).repeat(64); return { id, batchName: '演示 · 十月音乐集', name, version: id, sourceVideo: { id, filename: name + '.mp4', size: 1024 * 1024 * 120, mtimeMs: now, version: id }, title: name + ' | Lofi Radio', description: '演示内容，仅用于本地界面预览。', validationState: 'valid', issues: [] }; }) };
  const rule = { timezone: 'Asia/Shanghai', startDate: today, weeklySlots: [{ weekday: 1, time: '18:00' }, { weekday: 3, time: '18:00' }, { weekday: 5, time: '18:00' }], preuploadDays: 28 };
  const items = batch.packages.map((pkg, index) => ({ packageId: pkg.id, scheduleSource: 'auto', excluded: false, publishAt: new Date(now + (index + 1) * 86400000).toISOString() }));
  const draft = { id: randomUUID(), revision: 1, owner: 'Liang', actor: 'Liang', profile, batch, rule, items, copies: batch.packages.map(pkg => ({ packageId: pkg.id, title: pkg.title, description: pkg.description })), skippedOccupied: 0, skipped: [], createdAt: now };
  const previous = { ...structuredClone(draft), id: randomUUID(), batch: { ...batch, name: '演示 · 已配置音乐集' }, confirmedAt: now - 3600000, createdAt: now - 3600000 };
  const jobs = previous.items.map((item, index) => { const id = randomUUID(); const state = index < 2 ? 'published' : index === 2 ? 'uploading' : 'ready'; return { spec: { id, batchId: previous.id, owner: 'Liang', actor: 'Liang', revision: 1, desired: 'run', asset: batch.packages[index].sourceVideo, contentPackage: batch.packages[index], plan: rule, scheduleSource: 'auto', profile, index: index + 1, originalPublishAt: item.publishAt, overrides: {}, policy, consent: { version: '2026-10-01', acceptedAt: now, ai: false, temporaryPrivateTitle: true } }, createdAt: now, observed: { id, revision: 1, sequence: 1, state, total: 125829120, offset: index < 2 ? 125829120 : index === 2 ? 62914560 : 0, updatedAt: now, ...(index < 2 ? { videoId: 'preview_' + index, observedPrivacy: 'public', processingStatus: 'succeeded', remoteCheckedAt: now } : {}) } }; });
  const view = { profiles: [profile], accounts: [account], plans: [previous, draft], jobs, policy, cleanups: [], removals: [], consent: { version: '2026-10-01' }, administrator: false };
  /** 仅执行演示目录读取或草稿字段更新；发布、授权和清理都明确拒绝。 */
  function request(input) {
    if (input.action === 'packages') return { root: 'D:\\LiveNest-Preview\\Publishing', batches: [batch], channelId: account.channelId, channel: account.channel, thumbnails: [] };
    if (input.action === 'plan-update' && input.planId === draft.id && input.revision === draft.revision) { draft.items = input.items || draft.items; draft.rule = input.rule || draft.rule; draft.revision++; return draft; }
    throw new Error('本地界面预览：此操作不会提交到真实频道。可以编辑示例草稿、浏览日历和任务详情。');
  }
  return { view, request };
}
