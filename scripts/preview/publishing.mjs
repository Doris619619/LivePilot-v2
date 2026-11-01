/** 本地发布界面的合成数据；不调用 Agent、YouTube 或文件上传，编辑仅存在本次进程内。 */
import { randomUUID } from 'node:crypto';

/** 构造当前月份的草稿与多状态账号；首个账号继续拥有原有配置及任务，新增账号不共享授权。 */
export function createPublishingPreview() {
  const now = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const accountBase = { agentId: 'preview_liang', instanceId: 'main', owner: 'Liang', createdAt: now, updatedAt: now };
  const account = { ...accountBase, id: randomUUID(), name: '演示发布账号', status: 'connected', channelId: 'demo_ocean', channel: '演示 · Ocean Studio', channelCheckedAt: now, connectedAt: now };
  const accounts = [account,
    { ...accountBase, id: randomUUID(), name: '深夜电台', status: 'connected', channelId: 'demo_night', channel: '演示 · Nightfall Radio', channelCheckedAt: now, connectedAt: now - 86400000 },
    { ...accountBase, id: randomUUID(), name: '新的发布账号', status: 'unbound' },
    { ...accountBase, id: randomUUID(), name: '雨天音乐', status: 'needs_reauthorization', channelId: 'demo_rain', channel: '演示 · Rainy Day Music', connectedAt: now - 7 * 86400000 },
    { ...accountBase, id: randomUUID(), name: '旧频道', status: 'cleanup_pending', channelId: 'demo_old', channel: '演示 · Old Studio', connectedAt: now - 14 * 86400000 },
  ];
  const policy = { enabled: true, publicVerified: true, projectKey: 'preview', uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: '', verificationNote: '' };
  const profile = { id: randomUUID(), revision: 1, name: '每周音乐精选', agentId: account.agentId, instanceId: account.instanceId, accountId: account.id, channelId: account.channelId, titleTemplate: '{filename}', descriptionTemplate: '演示 · 安静的音乐时刻', tags: ['music', 'lofi'], categoryId: '10', playlistIds: [], privacy: 'public', scheduled: true, madeForKids: false, license: 'youtube', embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: 'none', ai: { enabled: false, language: '中文', prompt: '描述音乐场景', fallbackTitle: '{filename}', fallbackDescription: '' }, schedule: { timezone: 'Asia/Shanghai', weekdays: [1, 3, 5], localTime: '18:00', startDate: today, preuploadDays: 28 } };
  const names = ['海边日落', '东京雨夜', '山间云海', '午后咖啡', '深夜电台', '周末钢琴'];
  const batch = { id: 'a'.repeat(64), name: '演示 · 十月音乐集', version: 'b'.repeat(64), issues: [], packages: names.map((name, index) => { const id = (index + 1).toString(16).repeat(64); return { id, batchName: '演示 · 十月音乐集', name, version: id, sourceVideo: { id, filename: name + '.mp4', size: 1024 * 1024 * 120, mtimeMs: now, version: id }, title: name + ' | Lofi Radio', description: '演示内容，仅用于本地界面预览。', validationState: 'valid', issues: [] }; }) };
  const rule = { timezone: 'Asia/Shanghai', startDate: today, weeklySlots: [{ weekday: 1, time: '18:00' }, { weekday: 3, time: '18:00' }, { weekday: 5, time: '18:00' }], preuploadDays: 28 };
  const items = batch.packages.map((pkg, index) => ({ packageId: pkg.id, scheduleSource: 'auto', excluded: false, publishAt: new Date(now + (index + 1) * 86400000).toISOString() }));
  const draft = { id: randomUUID(), revision: 1, owner: 'Liang', actor: 'Liang', profile, batch, rule, items, copies: batch.packages.map(pkg => ({ packageId: pkg.id, title: pkg.title, description: pkg.description })), skippedOccupied: 0, skipped: [], createdAt: now };
  const previous = { ...structuredClone(draft), id: randomUUID(), batch: { ...batch, name: '演示 · 已配置音乐集' }, confirmedAt: now - 3600000, createdAt: now - 3600000 };
  const jobs = previous.items.map((item, index) => { const id = randomUUID(); const state = index < 2 ? 'published' : index === 2 ? 'uploading' : 'ready'; return { spec: { id, batchId: previous.id, owner: 'Liang', actor: 'Liang', revision: 1, desired: 'run', asset: batch.packages[index].sourceVideo, contentPackage: batch.packages[index], plan: rule, scheduleSource: 'auto', profile, index: index + 1, originalPublishAt: item.publishAt, overrides: {}, policy, consent: { version: '2026-10-01', acceptedAt: now, ai: false, temporaryPrivateTitle: true } }, createdAt: now, observed: { id, revision: 1, sequence: 1, state, total: 125829120, offset: index < 2 ? 125829120 : index === 2 ? 62914560 : 0, updatedAt: now, ...(index < 2 ? { videoId: 'preview_' + index, observedPrivacy: 'public', processingStatus: 'succeeded', remoteCheckedAt: now } : {}) } }; });
  const view = { profiles: [profile], accounts, plans: [previous, draft], jobs, policy, cleanups: [{ id: randomUUID(), agentId: account.agentId, instanceId: account.instanceId, accountId: accounts[4].id, deadline: now + 7 * 86400000, state: 'pending' }], removals: [], consent: { version: '2026-10-16' }, administrator: false };
  /** 演示创建仅增加当前预览的未连接记录；目录、配置和草稿仍为合成数据，授权及清理明确拒绝。 */
  function request(input) {
    if (input.action === 'packages') return { root: 'D:\\LiveNest-Preview\\Publishing', batches: [batch], channelId: account.channelId, channel: account.channel, thumbnails: [] };
    if (input.action === 'account-create') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (input.agentId !== account.agentId || input.instanceId !== account.instanceId || !name || name.length > 80) throw new Error('请选择示例电脑，并填写 1–80 个字符的账号名称。');
      const created = { ...accountBase, id: randomUUID(), name, status: 'unbound', createdAt: Date.now(), updatedAt: Date.now() };
      view.accounts.push(created);
      return structuredClone(created);
    }
    if (input.action === 'profile') {
      const next = input.profile;
      if (!next?.id || next.accountId !== account.id || next.agentId !== account.agentId || next.instanceId !== account.instanceId || next.channelId !== account.channelId) throw new Error('请选择示例发布账号。');
      const old = view.profiles.find(item => item.id === next.id);
      if (next.revision !== (old?.revision || 0) + 1) throw new Error('配置已更新，请重新读取。');
      const saved = structuredClone(next);
      view.profiles = [...view.profiles.filter(item => item.id !== saved.id), saved];
      return saved;
    }
    if (input.action === 'plan-update' && input.planId === draft.id && input.revision === draft.revision) { draft.items = input.items || draft.items; draft.rule = input.rule || draft.rule; draft.revision++; return draft; }
    throw new Error('本地界面预览：此操作不会提交到真实频道。可以编辑示例草稿、浏览日历和任务详情。');
  }
  return { view, request };
}
