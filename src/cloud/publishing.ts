/** Cloud 发布意图、Profile 快照、短指令投递和项目配额；不处理视频字节或 Google Token。 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Member } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
import { PublishingStore } from "@/core/publishing/storage";
import { scheduleSlots, quotaDay } from "@/core/publishing/schedule";
import { publishingMetadata, expandTemplate } from "@/core/publishing/metadata";
import { cloudStore, transaction } from "./store";
import { listAgents, requireTarget, agentStore } from "./agents";
import { enqueue, readTask, rpc } from "./tasks";
import { PRIVACY_VERSION, defaultPolicy, policySchema, profileSchema, assetsResultSchema, jobSpecSchema, publishingTerminal, type JobSpec, type ItemOverride, type PublishingProfile, type PublishingPolicy, type MediaAsset, type VideoJob, type PublishingReport } from "@/shared/publishing";
type Profile = { owner: string; value: PublishingProfile };
type Batch = { id: string; owner: string; actor: string; profile: PublishingProfile; assets: MediaAsset[]; thumbnails: string[]; copies: { title: string; description: string }[]; slots: { publishAt: string; local: string; overlapping: boolean }[]; skipped: string[]; confirmedAt?: number; createdAt: number };
type Cleanup = { id: string; owner: string; actor: string; agentId: string; instanceId: string; createdAt: number; deadline: number; state: "pending" | "complete"; completedAt?: number };
type Budget = { day: string; uploads: number; units: number; receipts: string[]; reservations?: Record<string, { uploads: number; units: number }> };
type State = { policy: PublishingPolicy; profiles: Profile[]; batches: Batch[]; jobs: VideoJob[]; consents: Record<string, { version: string; acceptedAt: number }>; cleanups: Cleanup[]; quota: Record<string, Budget> };
/** 当日项目账本在 admission 前初始化，预留不计作已发生的请求。 */
function quotaBudget(s: State, key: string) { if (s.quota[key]?.day !== quotaDay()) s.quota[key] = { day: quotaDay(), uploads: 0, units: 0, receipts: [], reservations: {} }; s.quota[key].reservations ??= {}; return s.quota[key]; }
/** 计算尚未消费的预留；可排除本任务以避免将自己的预算重复计算。 */
function reserved(budget: Budget, excluding?: string) { return Object.entries(budget.reservations || {}).filter(([id]) => id !== excluding).reduce((sum, [, v]) => ({ uploads: sum.uploads + v.uploads, units: sum.units + v.units }), { uploads: 0, units: 0 }); }
/** 派发前预留完整整理步骤与初始查询的估算，不够时 Cloud 保留计划等待重置。 */
function reserveJob(s: State, job: VideoJob) {
  const budget = quotaBudget(s, job.spec.policy.projectKey);
  if (budget.reservations![job.spec.id] || publishingTerminal(job.observed?.state) || ["scheduled", "paused"].includes(job.observed?.state || "") || job.spec.desired !== "run") return true;
  const estimate = { uploads: job.observed?.videoId ? 0 : 1, units: 54 + (job.spec.profile.thumbnailMode === "none" ? 0 : 50) + 52 * job.spec.profile.playlistIds.length };
  const other = reserved(budget);
  if (budget.uploads + other.uploads + estimate.uploads > s.policy.uploadsPerDay || budget.units + other.units + estimate.units > s.policy.otherUnitsPerDay) { job.blockReason = "等待项目发布预算及太平洋时间配额日重置。"; return false; }
  budget.reservations![job.spec.id] = estimate; delete job.blockReason; return true;
}
/** 用户删除或已确认授权失效共用清理记录；本地源文件不在此范围内。 */
function beginCleanup(s: State, agentId: string, instanceId: string, owner: string, actor: string) {
  const existing = s.cleanups.find(c => c.agentId === agentId && c.instanceId === instanceId && c.state === "pending"); if (existing) return existing;
  for (const job of s.jobs.filter(j => j.spec.profile.agentId === agentId && j.spec.profile.instanceId === instanceId)) for (const budget of Object.values(s.quota)) delete budget.reservations?.[job.spec.id];
  const item: Cleanup = { id: randomUUID(), owner, actor, agentId, instanceId, createdAt: Date.now(), deadline: Date.now() + 7 * 86400_000, state: "pending" };
  s.jobs = s.jobs.filter(j => j.spec.profile.agentId !== agentId || j.spec.profile.instanceId !== instanceId); s.profiles = s.profiles.filter(p => p.value.agentId !== agentId || p.value.instanceId !== instanceId); s.batches = s.batches.filter(b => b.profile.agentId !== agentId || b.profile.instanceId !== instanceId); s.cleanups.push(item); return item;
}
/** 发布数据独立保存，不改变旧账号、OAuth 和直播状态文件。 */
export function publishingStore() { return new PublishingStore(path.join(cloudStore().dir, "publishing")); }
/** 等待撤销期间禁止新的频道 API 指令，防止清理后又写回授权数据。 */
export async function assertNoPublishingCleanup(agentId: string, instanceId: string) { if ((await readState()).cleanups.some(c => c.agentId === agentId && c.instanceId === instanceId && c.state === "pending")) throw new AppError("CLEANUP", "等待设备清理授权数据，请完成后再连接频道。", 409); }
/** 缺文件是首次启用，损坏文件由 Store 报错，不能当作空队列。 */
async function readState() { return await publishingStore().read<State>("state.json") || { policy: { ...defaultPolicy }, profiles: [], batches: [], jobs: [], consents: {}, cleanups: [], quota: {} }; }
/** 所有编辑使用同一短事务，网络 RPC 位于事务之外。 */
async function edit<T>(fn: (state: State) => Promise<T> | T) { const store = publishingStore(); return transaction(store, async () => { const state = await readState(); const result = await fn(state); await store.write("state.json", state); return result; }, "publishing.lock"); }
/** 当前设备归属决定可见性，不依据创建任务时的旧所有者授予访问。 */
async function visible(user: Member) { return new Set((await listAgents()).filter(a => user.role === "admin" || a.owner === user.username).map(a => a.id)); }
/** 发布策略为产品设置，不等于 Google 配额；管理员更改会通过修订送到 Agent。 */
export async function savePublishingPolicy(user: Member, value: unknown) {
  if (user.role !== "admin") throw new AppError("FORBIDDEN", "只有管理员可修改项目配额和验收设置。", 403);
  const policy = policySchema.parse(value);
  if (policy.enabled && !policy.privacyContact.trim()) throw new AppError("INPUT", "开启发布前请配置可联系的隐私支持邮箱或地址。");
  if (policy.publicVerified && !policy.verificationNote.trim()) throw new AppError("INPUT", "启用自动公开前请记录真实 API Project、测试视频及验收证据。");
  await edit(state => { state.policy = policy; for (const job of state.jobs) if (!publishingTerminal(job.observed?.state)) { job.spec.policy = policy; job.spec.revision++; } });
  await audit(user.username, "publishing-policy", "cloud", "succeeded"); return policy;
}
/** 汇总 Profile、队列、日历和历史，页面只读取已缓存的 YouTube 观察结果。 */
export async function publishingView(user: Member) {
  const allowed = await visible(user); const state = await readState();
  const accepted = state.consents[user.username]?.version === PRIVACY_VERSION;
  const budget = state.quota[state.policy.projectKey];
  return { policy: { ...state.policy, verificationNote: user.role === "admin" ? state.policy.verificationNote : "" }, quota: user.role === "admin" && budget?.day === quotaDay() ? { day: budget.day, uploads: budget.uploads, units: budget.units, reserved: reserved(budget) } : undefined, profiles: accepted ? state.profiles.filter(p => allowed.has(p.value.agentId) && (user.role === "admin" || p.owner === user.username)).map(p => p.value) : [], jobs: accepted ? state.jobs.filter(j => allowed.has(j.spec.profile.agentId) && (user.role === "admin" || j.spec.owner === user.username)) : [], cleanups: state.cleanups.filter(c => allowed.has(c.agentId) && (user.role === "admin" || c.owner === user.username)), consent: state.consents[user.username], administrator: user.role === "admin" };
}
/** 记录产品隐私同意，不代替用户对具体上传批次和 AI 自动操作的确认。 */
export async function acceptPublishingPrivacy(user: Member, version: string) { if (version !== PRIVACY_VERSION) throw new AppError("INPUT", "隐私政策版本已更新，请重新阅读。"); await edit(s => { s.consents[user.username] = { version, acceptedAt: Date.now() }; }); return { ok: true }; }
/** 用户或获准管理员只为当前设备保存配置；频道来自已确认绑定。 */
export async function savePublishingProfile(user: Member, raw: unknown) {
  const profile = profileSchema.parse(raw); const agent = await authorizeAgent(user, profile.agentId); await requireTarget(profile.agentId, profile.instanceId);
  const bindings = await cloudStore().read<{ agentId: string; instanceId: string; channelId: string; confirmed: boolean }[]>("bindings.json");
  if (!bindings?.some(b => b.agentId === profile.agentId && b.instanceId === profile.instanceId && b.channelId === profile.channelId && b.confirmed)) throw new AppError("CHANNEL", "请选择该实例已授权的频道。");
  return edit(state => {
    if (state.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "使用 YouTube 发布前请先同意隐私政策。");
    if (state.cleanups.some(c => c.agentId === profile.agentId && c.instanceId === profile.instanceId && c.state === "pending")) throw new AppError("CLEANUP", "请等待设备完成授权清理后重新连接频道。");
    const previous = state.profiles.find(p => p.value.id === profile.id);
    if (previous && (previous.value.agentId !== profile.agentId || previous.value.instanceId !== profile.instanceId || previous.owner !== (agent.owner || user.username))) throw new AppError("FORBIDDEN", "配置归属或目标不可被替换。", 403);
    if (previous && profile.revision !== previous.value.revision + 1 || !previous && profile.revision !== 1) throw new AppError("REVISION", "配置已更新，请刷新后重试。", 409);
    if (previous) previous.value = profile; else state.profiles.push({ owner: agent.owner || user.username, value: profile });
    return profile;
  });
}
/** 素材扫描短 RPC，旧设备无能力时提前拒绝，未连接时不伪造素材。 */
export async function publishingAssets(user: Member, agentId: string, instanceId: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "读取 YouTube 素材和频道前请同意隐私政策。");
  await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId, true);
  if (!(await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-v1")) throw new AppError("AGENT_VERSION", "请先升级这台电脑的 Agent 以使用视频发布。", 409);
  return assetsResultSchema.parse(await rpc({ agentId, instanceId }, user.username, { kind: "publishing-assets" }));
}
/** 服务端生成持久预览；确认只能引用这个快照，浏览器不能更换文件属性或频道。 */
export async function previewPublishingBatch(user: Member, profileId: string, assetIds: string[]) {
  const state = await readState(); const profile = state.profiles.find(p => p.value.id === profileId)?.value;
  if (!profile) throw new AppError("PROFILE", "发布配置不存在。", 404);
  if (user.role !== "admin" && state.profiles.find(p => p.value.id === profileId)?.owner !== user.username) throw new AppError("FORBIDDEN", "配置不属于当前客户。", 403);
  const agent = await authorizeAgent(user, profile.agentId);
  if (!assetIds.length || assetIds.length > 1000 || new Set(assetIds).size !== assetIds.length) throw new AppError("INPUT", "请选择 1–1000 个不同视频。");
  const result = await publishingAssets(user, profile.agentId, profile.instanceId);
  if (result.channelId !== profile.channelId) throw new AppError("CHANNEL", "当前授权频道与 Profile 不一致。");
  const assets = assetIds.map(id => { const asset = result.assets.find(a => a.id === id); if (!asset) throw new AppError("ASSET", "所选视频已变化，请重新扫描。"); return asset; });
  if (profile.thumbnailMode === "fixed" && !result.thumbnails.includes(profile.thumbnailFilename!)) throw new AppError("THUMBNAIL", "固定缩略图不存在。");
  const scheduled = profile.scheduled ? scheduleSlots(profile.schedule, assets.length) : { slots: [], skipped: [] };
  const copies = assets.map((asset, index) => { const context = { asset, index: index + 1, profile, originalPublishAt: scheduled.slots[index]?.publishAt } as JobSpec; return { title: expandTemplate(profile.ai.enabled ? profile.ai.fallbackTitle : profile.titleTemplate, context), description: expandTemplate(profile.ai.enabled ? profile.ai.fallbackDescription : profile.descriptionTemplate, context) }; });
  const batch: Batch = { id: randomUUID(), owner: agent.owner || user.username, actor: user.username, profile: structuredClone(profile), assets, thumbnails: result.thumbnails, copies, ...scheduled, createdAt: Date.now() };
  await edit(s => { if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请先同意隐私政策。"); s.batches = s.batches.filter(b => b.confirmedAt || b.createdAt > Date.now() - 86400_000); s.batches.push(batch); });
  return batch;
}
/** 批次确认幂等；Profile 和顺序固定，阻止同素材/同频道活动重复及计划时刻冲突。 */
export async function confirmPublishingBatch(user: Member, id: string, ai: boolean, temporaryPrivateTitle: boolean, overrides: ItemOverride[] = []) {
  const before = await readState(); const batch = before.batches.find(b => b.id === id); if (!batch) throw new AppError("BATCH", "排期预览已过期，请重新预览。");
  const agent = await authorizeAgent(user, batch.profile.agentId);
  if (agent.owner && agent.owner !== batch.owner || user.role !== "admin" && batch.actor !== user.username) throw new AppError("FORBIDDEN", "排期归属已改变。", 403);
  if (!temporaryPrivateTitle || batch.profile.ai.enabled && !ai) throw new AppError("CONSENT", "请明确同意临时私密上传与所选 AI 自动文案规则。");
  const result = await edit(async state => {
    const saved = state.batches.find(b => b.id === id)!;
    if (saved.confirmedAt) return state.jobs.filter(j => j.spec.batchId === id);
    if (state.cleanups.some(c => c.agentId === saved.profile.agentId && c.instanceId === saved.profile.instanceId && c.state === "pending")) throw new AppError("CLEANUP", "设备授权清理尚未完成。");
    if (overrides.some(v => !saved.assets.some(a => a.id === v.assetId)) || new Set(overrides.map(v => v.assetId)).size !== overrides.length) throw new AppError("INPUT", "逐项覆盖必须对应本批次的不重复素材。");
    if (state.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。");
    if (!state.policy.enabled) throw new AppError("PUBLISHING_DISABLED", "发布模块尚未开启，请联系管理员。");
    if (saved.profile.privacy === "public" && !state.policy.publicVerified) throw new AppError("PUBLIC_UNVERIFIED", "当前项目未完成公开验收；可先用 private 配置验证上传恢复。");
    const jobs: VideoJob[] = [];
    for (const [index, asset] of saved.assets.entries()) {
      const override = overrides.find(v => v.assetId === asset.id); const thumbnail = override?.thumbnail || asset.thumbnail;
      if (override?.thumbnail && !saved.thumbnails.includes(override.thumbnail) || saved.profile.thumbnailMode === "matching" && !thumbnail) throw new AppError("THUMBNAIL", "请为视频选择已准备的缩略图：" + asset.filename);
      const at = saved.slots[index]?.publishAt;
      if (state.jobs.some(j => !["cancelled", "failed"].includes(j.observed?.state || "") && j.spec.profile.channelId === saved.profile.channelId && (j.spec.asset.version === asset.version || asset.sha256 && j.spec.asset.sha256 === asset.sha256 || at && j.spec.originalPublishAt === at))) throw new AppError("DUPLICATE", "同频道已有相同素材任务或排期时刻，请先核对原任务。");
      const spec = jobSpecSchema.parse({ id: randomUUID(), batchId: id, owner: saved.owner, actor: saved.actor, revision: 1, desired: "run", asset: { ...asset, ...(thumbnail ? { thumbnail } : {}) }, profile: saved.profile, index: index + 1, originalPublishAt: at, overrides: { ...(override?.title !== undefined ? { title: override.title } : {}), ...(override?.description !== undefined ? { description: override.description } : {}) }, policy: state.policy, consent: { version: PRIVACY_VERSION, acceptedAt: Date.now(), ai, temporaryPrivateTitle: true } });
      // AI 不在 Cloud 执行；非 AI 模板在确认时即可发现无效文案。
      if (!spec.profile.ai.enabled) await publishingMetadata(publishingStore(), spec);
      jobs.push({ spec, initialPublishAt: at, createdAt: Date.now() });
    }
    saved.confirmedAt = Date.now(); state.jobs.push(...jobs); return jobs;
  });
  await audit(user.username, "publishing-confirm", batch.profile.instanceId, "succeeded"); return result;
}
/** 用户控制先保存 desired/revision；远端状态收到 Agent 确认后才改变。 */
export async function changePublishingJob(user: Member, id: string, action: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) {
  const state = await readState(); const old = state.jobs.find(j => j.spec.id === id); if (!old) throw new AppError("JOB", "任务不存在。", 404);
  const agent = await authorizeAgent(user, old.spec.profile.agentId); if (agent.owner && agent.owner !== old.spec.owner) throw new AppError("FORBIDDEN", "任务设备归属已变更。", 403);
  const result = await edit(s => {
    const job = s.jobs.find(j => j.spec.id === id)!;
    if (["published", "completed", "cancelled"].includes(job.observed?.state || "") && action !== "reconcile") throw new AppError("TERMINAL", "任务已结束；已公开视频请在 Studio 管理。");
    if (action === "reschedule") { if (!job.spec.profile.scheduled || !publishAt || !Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt) <= Date.now()) throw new AppError("INPUT", "请选择未来的有效定时公开时刻。"); if (s.jobs.some(j => j.spec.id !== id && j.spec.profile.channelId === job.spec.profile.channelId && !["cancelled", "failed"].includes(j.observed?.state || "") && j.spec.originalPublishAt === publishAt)) throw new AppError("DUPLICATE", "该频道排期时刻已占用。"); job.spec.originalPublishAt = publishAt; }
    job.spec.desired = action === "pause" ? "pause" : action === "cancel" ? "cancel" : "run"; job.spec.revision++; return job;
  });
  await audit(user.username, "publishing-" + action, old.spec.profile.instanceId, "accepted"); return result;
}
/** Agent 报告按 task revision 和全局单调 sequence 核对，不接受未知任务或其他实例数据。 */
export async function reportPublishing(agentId: string, values: PublishingReport[]) {
  return edit(s => values.map(report => {
    const job = s.jobs.find(j => j.spec.id === report.id);
    if (!job) return { id: report.id, sequence: report.sequence };
    if (job.spec.profile.agentId !== agentId || report.revision > job.spec.revision || report.total !== job.spec.asset.size || report.offset > report.total) throw new AppError("REPORT", "发布报告目标、版本或进度无效。", 403);
    if (report.authorizationInvalid) { beginCleanup(s, agentId, job.spec.profile.instanceId, job.spec.owner, job.spec.actor); return { id: report.id, sequence: report.sequence }; }
    if (!job.observed || job.observed.sequence < report.sequence) { job.observed = report; delete job.blockReason; if (report.revision === job.spec.revision && (publishingTerminal(report.state) || ["scheduled", "paused", "needs_attention"].includes(report.state))) for (const budget of Object.values(s.quota)) delete budget.reservations?.[job.spec.id]; }
    return { id: report.id, sequence: report.sequence };
  }));
}
/** 对每次实际 API 调用先持久化 admission；未知远端结果不退回预算。 */
export async function chargePublishing(agentId: string, id: string, receipt: string, units: number, upload: boolean) {
  const machine = (await listAgents()).find(a => a.id === agentId);
  return edit(s => {
    const job = s.jobs.find(j => j.spec.id === id); if (!job || job.spec.profile.agentId !== agentId) throw new AppError("FORBIDDEN", "发布任务不属于此设备。", 403);
    if (!machine || machine.revoked || machine.owner && machine.owner !== job.spec.owner) throw new AppError("FORBIDDEN", "设备归属已改变，停止新发布 API 操作。", 403);
    const budget = quotaBudget(s, job.spec.policy.projectKey);
    if (budget.receipts.includes(receipt)) return { ok: true };
    const others = reserved(budget, job.spec.id); const own = budget.reservations![job.spec.id];
    if (budget.uploads + others.uploads + Math.max(Number(upload), own?.uploads || 0) > s.policy.uploadsPerDay || budget.units + others.units + Math.max(units, own?.units || 0) > s.policy.otherUnitsPerDay) throw new AppError("VIDEO_QUOTA", "普通发布的项目预算已用完，等待太平洋时间配额日重置。", 503);
    if (own) { own.uploads = Math.max(0, own.uploads - Number(upload)); own.units = Math.max(0, own.units - units); }
    budget.uploads += Number(upload); budget.units += units; budget.receipts.push(receipt); return { ok: true };
  });
}
/** 删除请求持久保存到设备确认；立即停止新派发并移除 Cloud 发布数据。 */
export async function requestPublishingCleanup(user: Member, agentId: string, instanceId: string) {
  const agent = await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId);
  const cleanup = await edit(s => beginCleanup(s, agentId, instanceId, agent.owner || user.username, user.username));
  const store = agentStore(agentId); await transaction(store, async () => { const queue = await store.read<{ records: { kind: string; instanceId: string }[] }>("tasks.json"); if (queue) { queue.records = queue.records.filter(r => r.instanceId !== instanceId || !r.kind.startsWith("publishing-")); await store.write("tasks.json", queue); } }, "tasks.lock");
  await audit(user.username, "youtube-data-delete", instanceId, "accepted"); return cleanup;
}
/** 启动/重连后在普通指令之前取得待撤销任务。 */
export async function publishingCleanups(agentId: string) { return (await readState()).cleanups.filter(c => c.agentId === agentId && c.state === "pending").map(c => ({ id: c.id, instanceId: c.instanceId, createdAt: c.createdAt })); }
/** 所有已授权数据已被 Agent 清理且 Google 撤销确认后才显示完成。 */
export async function completePublishingCleanup(agentId: string, id: string) {
  const cleanup = (await readState()).cleanups.find(c => c.id === id && c.agentId === agentId); if (!cleanup) throw new AppError("CLEANUP", "清理请求不存在。");
  const store = cloudStore(); await transaction(store, async () => { const bindings = await store.read<{ agentId: string; instanceId: string }[]>("bindings.json"); if (bindings) await store.write("bindings.json", bindings.filter(b => b.agentId !== agentId || b.instanceId !== cleanup.instanceId)); });
  const local = agentStore(agentId); await transaction(local, async () => { const queue = await local.read<{ records: { instanceId: string; kind: string; status: string }[] }>("tasks.json"); if (queue) { queue.records = queue.records.filter(r => r.instanceId !== cleanup.instanceId || !(r.kind.startsWith("publishing-") || r.kind.startsWith("oauth-") || ["broadcast-playlists", "broadcast-read", "control"].includes(r.kind))); await local.write("tasks.json", queue); } }, "tasks.lock");
  const heartbeat = await local.read<{ snapshots: { instance: { id: string }; dashboard: { youtube: unknown; state: Record<string, unknown> } }[] }>("heartbeat.json");
  if (heartbeat) { for (const snapshot of heartbeat.snapshots) if (snapshot.instance.id === cleanup.instanceId) { snapshot.dashboard.youtube = { connected: false, authorization: "missing" }; for (const key of ["channelId", "broadcastId", "streamId", "broadcastTitle", "streamTitle"]) delete snapshot.dashboard.state[key]; } await local.write("heartbeat.json", heartbeat); }
  await edit(s => { const c = s.cleanups.find(c => c.id === id && c.agentId === agentId)!; c.state = "complete"; c.completedAt = Date.now(); }); return { ok: true };
}
/** 隐私页只公开运营者配置的联系信息，不能公开任务、频道或项目凭据。 */
export async function publishingPrivacyContact() { return (await readState()).policy.privacyContact || "尚未配置，请联系为您分配设备的管理员。"; }
/** 云服务 tick：只派发窗口内任务，离线保留，任务修订与投递幂等 ID 独立。 */
export async function publishingTick() {
  const state = await readState(); const agents = await listAgents();
  for (const job of state.jobs) {
    const p = job.spec.profile; const agent = agents.find(a => a.id === p.agentId);
    if (!agent || agent.revoked || agent.owner && agent.owner !== job.spec.owner || !agent.online || agent.maintenance) continue;
    if (job.spec.desired === "run" && (!state.policy.enabled && !job.observed || publishingTerminal(job.observed?.state) && job.observed?.revision === job.spec.revision || !job.observed?.videoId && job.spec.originalPublishAt && Date.parse(job.spec.originalPublishAt) > Date.now() + p.schedule.preuploadDays * 86400_000)) continue;
    if (!(await agentStore(p.agentId).read<string[]>("capabilities.json"))?.includes("publishing-v1")) continue;
    if (job.observed?.revision === job.spec.revision) continue;
    if (!await edit(s => { const current = s.jobs.find(j => j.spec.id === job.spec.id); return !!current && reserveJob(s, current); })) continue;
    let delivery = job.delivery;
    const old = delivery ? await readTask(p.agentId, delivery.id) : undefined;
    if (!delivery || delivery.revision !== job.spec.revision || old && ["expired", "interrupted", "failed"].includes(old.status)) {
      delivery = await edit(s => { const actual = s.jobs.find(j => j.spec.id === job.spec.id); if (!actual || actual.spec.revision !== job.spec.revision) return undefined; actual.delivery = { id: randomUUID(), revision: job.spec.revision }; return actual.delivery; });
    }
    if (!delivery) continue;
    try { await enqueue({ agentId: p.agentId, instanceId: p.instanceId }, job.spec.actor, { kind: "publishing-apply", job: job.spec }, delivery.id); } catch { /* 离线、维护和归属变更保留意图，下次 tick 再核对。 */ }
  }
  // 过期 API 观察数据移除；用户自己的配置和计划不伪装成最新 YouTube 状态。
  await edit(s => { for (const job of s.jobs) if (job.observed && (job.observed.remoteCheckedAt || job.observed.updatedAt) < Date.now() - 30 * 86400_000) { delete job.observed.videoId; delete job.observed.metadata; delete job.observed.observedPrivacy; delete job.observed.processingStatus; job.observed.message = "YouTube 观察数据已超过保存期限，等待重新授权/核对。"; } });
}
/** Next.js 单进程启动周期任务；只返回启动结果，不阻塞 register 到循环结束。 */
export async function startPublishingScheduler() {
  const registry = globalThis as typeof globalThis & { publishingTimer?: ReturnType<typeof setTimeout>; publishingTickRunning?: boolean };
  if (registry.publishingTimer) return;
  /** 完成本次事务后再调下一次，异常不停止直播 Web 服务。 */
  async function loop() { if (registry.publishingTickRunning) return; registry.publishingTickRunning = true; try { await publishingTick(); } catch { /* 健康状态由队列持续可见，不输出私有错误。 */ } finally { registry.publishingTickRunning = false; const policy = (await readState().catch(() => null))?.policy || defaultPolicy; registry.publishingTimer = setTimeout(() => { void loop(); }, policy.tickSeconds * 1000); registry.publishingTimer.unref(); } }
  registry.publishingTimer = setTimeout(() => { void loop(); }, 1000); registry.publishingTimer.unref();
}
