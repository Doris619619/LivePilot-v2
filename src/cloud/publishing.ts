/** Cloud 发布意图、Profile 快照、短指令投递和项目配额；不处理视频字节或 Google Token。 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Member } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { AppError, isAppError } from "@/core/errors";
import { audit } from "@/core/audit";
import { PublishingStore } from "@/core/publishing/storage";
import { scheduleSlots, quotaDay } from "@/core/publishing/schedule";
import { generatePublishingPlan, occupiedPublishingSlots } from "./publishing-plan";
import { applyConfirmedSchedule, generateConfirmedSchedule, scheduleEditable, scheduleFingerprint, type SchedulePreview } from "./publishing-reschedule";
import { publishingMetadata, expandTemplate } from "@/core/publishing/metadata";
import { cloudStore, transaction } from "./store";
import { listAgents, requireTarget, agentStore } from "./agents";
import { enqueue, readTask, rpc } from "./tasks";
import { playlistResultSchema } from "@/shared/broadcast";
import { unseal } from "@/core/storage";
import { publishingTaskAccountId, type TaskPayload } from "@/shared/remote";
import { authorizePublishingAccount, beginPublishingAccountCleanup, completePublishingAccountCleanup, createPublishingAccount as newPublishingAccount, expirePublishingAccountData, publishingAccountCleanups, publishingAccounts, requestPublishingAccountCleanup as accountCleanup, requirePublishingAccount, requirePublishingAccountsCapability } from "./publishing-accounts";
import { PRIVACY_VERSION, defaultPolicy, policySchema, profileSchema, assetsResultSchema, packagesResultSchema, planRuleSchema, jobSpecSchema, publishingTerminal, type JobSpec, type ItemOverride, type PublishingProfile, type PublishingPolicy, type PublishingPlan, type PublishingPlanItem, type MediaAsset, type VideoJob, type PublishingReport } from "@/shared/publishing";
type Profile = { owner: string; value: PublishingProfile };
type Batch = { id: string; owner: string; actor: string; profile: PublishingProfile; assets: MediaAsset[]; thumbnails: string[]; copies: { title: string; description: string }[]; slots: { publishAt: string; local: string; overlapping: boolean }[]; skipped: string[]; confirmedAt?: number; createdAt: number };
type Cleanup = { id: string; owner: string; actor: string; agentId: string; instanceId: string; createdAt: number; deadline: number; state: "pending" | "complete"; completedAt?: number };
type Budget = { day: string; uploads: number; units: number; receipts: string[]; reservations?: Record<string, { uploads: number; units: number }> };
type PlanRecord = PublishingPlan & { archiveDestination?: string };
type State = { policy: PublishingPolicy; profiles: Profile[]; batches: Batch[]; plans: PlanRecord[]; schedulePreviews: SchedulePreview[]; jobs: VideoJob[]; consents: Record<string, { version: string; acceptedAt: number }>; cleanups: Cleanup[]; quota: Record<string, Budget> };
/** 当日项目账本在 admission 前初始化，预留不计作已发生的请求。 */
function quotaBudget(s: State, key: string) { if (s.quota[key]?.day !== quotaDay()) s.quota[key] = { day: quotaDay(), uploads: 0, units: 0, receipts: [], reservations: {} }; s.quota[key].reservations ??= {}; return s.quota[key]; }
/** 计算尚未消费的预留；可排除本任务以避免将自己的预算重复计算。 */
function reserved(budget: Budget, excluding?: string) { return Object.entries(budget.reservations || {}).filter(([id]) => id !== excluding).reduce((sum, [, v]) => ({ uploads: sum.uploads + v.uploads, units: sum.units + v.units }), { uploads: 0, units: 0 }); }
/** 派发前预留完整整理步骤与初始查询的估算，不够时 Cloud 保留计划等待重置。 */
function reserveJob(s: State, job: VideoJob) {
  if (job.spec.reconcileRevision === job.spec.revision) return true;
  const budget = quotaBudget(s, job.spec.policy.projectKey);
  if (budget.reservations![job.spec.id] || publishingTerminal(job.observed?.state) || ["scheduled", "paused"].includes(job.observed?.state || "") || job.spec.desired !== "run") return true;
  const estimate = { uploads: job.observed?.videoId ? 0 : 1, units: 54 + (job.spec.profile.thumbnailMode === "none" ? 0 : 50) + 52 * job.spec.profile.playlistIds.length };
  const other = reserved(budget);
  if (budget.uploads + other.uploads + estimate.uploads > s.policy.uploadsPerDay || budget.units + other.units + estimate.units > s.policy.otherUnitsPerDay) { job.blockReason = "等待项目发布预算及太平洋时间配额日重置。"; job.budgetWaiting = true; return false; }
  budget.reservations![job.spec.id] = estimate; delete job.blockReason; delete job.budgetWaiting; return true;
}
/** 用户删除或已确认授权失效共用清理记录；本地源文件不在此范围内。 */
function beginCleanup(s: State, agentId: string, instanceId: string, owner: string, actor: string) {
  const existing = s.cleanups.find(c => c.agentId === agentId && c.instanceId === instanceId && c.state === "pending"); if (existing) return existing;
  for (const job of s.jobs.filter(j => !j.spec.profile.accountId && j.spec.profile.agentId === agentId && j.spec.profile.instanceId === instanceId)) for (const budget of Object.values(s.quota)) delete budget.reservations?.[job.spec.id];
  const item: Cleanup = { id: randomUUID(), owner, actor, agentId, instanceId, createdAt: Date.now(), deadline: Date.now() + 7 * 86400_000, state: "pending" };
  s.jobs = s.jobs.filter(j => !!j.spec.profile.accountId || j.spec.profile.agentId !== agentId || j.spec.profile.instanceId !== instanceId); s.profiles = s.profiles.filter(p => !!p.value.accountId || p.value.agentId !== agentId || p.value.instanceId !== instanceId); s.batches = s.batches.filter(b => !!b.profile.accountId || b.profile.agentId !== agentId || b.profile.instanceId !== instanceId); s.plans = s.plans.filter(p => !!p.profile.accountId || p.profile.agentId !== agentId || p.profile.instanceId !== instanceId); s.schedulePreviews = s.schedulePreviews.filter(p => s.plans.some(plan => plan.id === p.planId)); s.cleanups.push(item); return item;
}
/** 发布数据独立保存，不改变旧账号、OAuth 和直播状态文件。 */
export function publishingStore() { return new PublishingStore(path.join(cloudStore().dir, "publishing")); }
/** 等待撤销期间禁止新的频道 API 指令，防止清理后又写回授权数据。 */
export async function assertNoPublishingCleanup(agentId: string, instanceId: string, accountId?: string) { if (accountId) { await requirePublishingAccount(agentId, instanceId, accountId, undefined, false); return; } if ((await readState()).cleanups.some(c => c.agentId === agentId && c.instanceId === instanceId && c.state === "pending")) throw new AppError("CLEANUP", "等待设备清理授权数据，请完成后再连接频道。", 409); }
/** 旧开关仅归一协议值，不改任务修订、期望状态或排期；损坏文件不能当作空队列。 */
async function readState() { const saved = await publishingStore().read<State>("state.json"); if (saved) { saved.plans ??= []; saved.schedulePreviews ??= []; saved.policy = policySchema.parse(saved.policy); for (const job of saved.jobs) { job.spec.policy = policySchema.parse(job.spec.policy); if (uploadObserved(job.observed)) job.hadUpload = true; } return saved; } return { policy: { ...defaultPolicy }, profiles: [], batches: [], plans: [], schedulePreviews: [], jobs: [], consents: {}, cleanups: [], quota: {} } as State; }
/** 自有上传执行事实不随 API 数据过期删除；进入上传阶段保守视为可能已建立远端会话。 */
function uploadObserved(report?: PublishingReport) { return !!report && (!!report.videoId || report.offset > 0 || ["uploading", "processing", "finalizing", "scheduled", "published", "completed"].includes(report.state)); }
/** 所有编辑使用同一短事务，网络 RPC 位于事务之外。 */
async function edit<T>(fn: (state: State) => Promise<T> | T) { const store = publishingStore(); return transaction(store, async () => { const state = await readState(); const result = await fn(state); await store.write("state.json", state); return result; }, "publishing.lock"); }
/** 当前设备归属决定可见性，不依据创建任务时的旧所有者授予访问。 */
async function visible(user: Member) { return new Set((await listAgents()).filter(a => user.role === "admin" || a.owner === user.username).map(a => a.id)); }
/** 写事务内重新核对设备和授权；清理先停用账号再取得此锁，迟到扫描不能复活已删除的数据。 */
async function authorizePublishingWrite(user: Member, profile: PublishingProfile, owner: string, state: State) {
  const agent = await authorizeAgent(user, profile.agentId); await requireTarget(profile.agentId, profile.instanceId);
  if (agent.owner && agent.owner !== owner || user.role !== "admin" && owner !== user.username) throw new AppError("FORBIDDEN", "发布目标或客户归属已改变。", 403);
  if (profile.accountId) { await requirePublishingAccount(profile.agentId, profile.instanceId, profile.accountId, profile.channelId); await authorizePublishingAccount(user, profile.accountId, true); }
  else {
    if (state.cleanups.some(cleanup => cleanup.agentId === profile.agentId && cleanup.instanceId === profile.instanceId && cleanup.state === "pending")) throw new AppError("CLEANUP", "设备授权清理尚未完成。", 409);
    const bindings = await cloudStore().read<{ agentId: string; instanceId: string; channelId: string; confirmed: boolean }[]>("bindings.json");
    if (!bindings?.some(binding => binding.agentId === profile.agentId && binding.instanceId === profile.instanceId && binding.channelId === profile.channelId && binding.confirmed)) throw new AppError("CHANNEL", "发布目标授权已变化，请重新连接原频道。", 409);
  }
}
/** 运行参数送到正常活动任务；人工处理和终态不广播修订，避免保存预算变成继续执行。 */
export async function savePublishingPolicy(user: Member, value: unknown) {
  if (user.role !== "admin") throw new AppError("FORBIDDEN", "只有管理员可修改项目配额和运行设置。", 403);
  const policy = policySchema.parse(value);
await edit(state => { state.policy = policy; for (const job of state.jobs) if (!publishingTerminal(job.observed?.state) && job.observed?.state !== "needs_attention") { job.spec.policy = policy; job.spec.revision++; delete job.spec.reconcileRevision; delete job.spec.reconcileTotal; } });
  await audit(user.username, "publishing-policy", "cloud", "succeeded"); return policy;
}
/** 汇总 Profile、队列、日历和历史，页面只读取已缓存的 YouTube 观察结果。 */
export async function publishingView(user: Member) {
  const allowed = await visible(user); const state = await readState();
  const accounts = await publishingAccounts(user); const cleanupAccounts = await publishingAccountCleanups();
  const accepted = state.consents[user.username]?.version === PRIVACY_VERSION;
  const budget = state.quota[state.policy.projectKey];
  return { accounts: accepted ? accounts : [], policy: { ...state.policy, verificationNote: user.role === "admin" ? state.policy.verificationNote : "" }, quota: user.role === "admin" && budget?.day === quotaDay() ? { day: budget.day, uploads: budget.uploads, units: budget.units, reserved: reserved(budget) } : undefined, profiles: accepted ? state.profiles.filter(p => allowed.has(p.value.agentId) && (user.role === "admin" || p.owner === user.username)).map(p => p.value) : [], plans: accepted ? state.plans.filter(p => allowed.has(p.profile.agentId) && (user.role === "admin" || p.owner === user.username)) : [], jobs: accepted ? state.jobs.filter(j => allowed.has(j.spec.profile.agentId) && (user.role === "admin" || j.spec.owner === user.username)) : [], cleanups: [...state.cleanups, ...cleanupAccounts].filter(c => allowed.has(c.agentId) && (user.role === "admin" || c.owner === user.username)), consent: state.consents[user.username], administrator: user.role === "admin" };
}
/** 记录产品隐私同意，不代替用户对具体上传批次和 AI 自动操作的确认。 */
export async function acceptPublishingPrivacy(user: Member, version: string) { if (version !== PRIVACY_VERSION) throw new AppError("INPUT", "隐私政策版本已更新，请重新阅读。"); await edit(s => { s.consents[user.username] = { version, acceptedAt: Date.now() }; }); return { ok: true }; }
/** 账号创建是独立发布入口，首次使用仍需明确接受产品隐私政策。 */
export async function createPublishingAccount(user: Member, agentId: string, instanceId: string, name: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请先同意隐私政策再创建发布账号。");
  const account = await newPublishingAccount(user, agentId, instanceId, name); await audit(user.username, "publishing-account-create", instanceId, "succeeded"); return account;
}
/** 连接只发起用户所选账号的 OAuth 桥；Cookie 由 HTTP 层保存，不能进入 Browser DTO。 */
export async function connectPublishingAccount(user: Member, accountId: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "连接 YouTube 前请先同意隐私政策。");
  const account = await authorizePublishingAccount(user, accountId); const result = await (await import("./oauth")).beginRemoteOAuth({ agentId: account.agentId, instanceId: account.instanceId }, user.username, account.id);
  await audit(user.username, "publishing-account-connect", account.instanceId, "started"); return result;
}
/** 只读取独立发布授权下的 Playlist，不接触宿主直播授权。 */
export async function publishingAccountPlaylists(user: Member, accountId: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请先同意隐私政策。");
  const account = await authorizePublishingAccount(user, accountId, true); await requirePublishingAccountsCapability(account.agentId);
  return playlistResultSchema.parse(await rpc({ agentId: account.agentId, instanceId: account.instanceId }, user.username, { kind: "publishing-account-playlists", accountId }));
}
/** 用户或获准管理员只为当前设备保存配置；频道来自已确认绑定。 */
export async function savePublishingProfile(user: Member, raw: unknown) {
  const profile = profileSchema.parse(raw); const agent = await authorizeAgent(user, profile.agentId); await requireTarget(profile.agentId, profile.instanceId);
  if (profile.accountId) { await requirePublishingAccountsCapability(profile.agentId); await authorizePublishingAccount(user, profile.accountId, true); await requirePublishingAccount(profile.agentId, profile.instanceId, profile.accountId, profile.channelId); }
  const bindings = await cloudStore().read<{ agentId: string; instanceId: string; channelId: string; confirmed: boolean }[]>("bindings.json");
  if (!profile.accountId && !bindings?.some(b => b.agentId === profile.agentId && b.instanceId === profile.instanceId && b.channelId === profile.channelId && b.confirmed)) throw new AppError("CHANNEL", "请选择该实例已授权的频道。");
  return edit(async state => {
    await authorizePublishingWrite(user, profile, agent.owner || user.username, state);
    if (state.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "使用 YouTube 发布前请先同意隐私政策。");
    if (!profile.accountId && state.cleanups.some(c => c.agentId === profile.agentId && c.instanceId === profile.instanceId && c.state === "pending")) throw new AppError("CLEANUP", "请等待设备完成授权清理后重新连接频道。");
    const previous = state.profiles.find(p => p.value.id === profile.id);
    if (previous && (previous.value.agentId !== profile.agentId || previous.value.instanceId !== profile.instanceId || previous.value.accountId !== profile.accountId || previous.owner !== (agent.owner || user.username))) throw new AppError("FORBIDDEN", "配置归属或目标不可被替换。", 403);
    if (previous && profile.revision !== previous.value.revision + 1 || !previous && profile.revision !== 1) throw new AppError("REVISION", "配置已更新，请刷新后重试。", 409);
    if (previous) previous.value = profile; else state.profiles.push({ owner: agent.owner || user.username, value: profile });
    return profile;
  });
}
/** 素材扫描短 RPC，旧设备无能力时提前拒绝，未连接时不伪造素材。 */
export async function publishingAssets(user: Member, agentId: string, instanceId: string, accountId?: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "读取 YouTube 素材和频道前请同意隐私政策。");
  await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId, true);
  if (!(await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-v1")) throw new AppError("AGENT_VERSION", "请先升级这台电脑的 Agent 以使用视频发布。", 409);
  if (accountId) { await requirePublishingAccountsCapability(agentId); await authorizePublishingAccount(user, accountId, true); await requirePublishingAccount(agentId, instanceId, accountId); }
  return assetsResultSchema.parse(await rpc({ agentId, instanceId }, user.username, { kind: "publishing-assets", ...(accountId ? { accountId } : {}) }));
}
/** 发布目录由目标设备返回；新版包协议不向旧 Agent 投递，也不接受浏览器提供绝对路径。 */
export async function publishingPackages(user: Member, agentId: string, instanceId: string, accountId?: string) {
  if ((await readState()).consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "读取发布目录前请同意隐私政策。");
  await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId, true);
  if (!(await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-v2")) throw new AppError("AGENT_VERSION", "请升级这台电脑的 Agent 以读取发布包。", 409);
  if (accountId) { await requirePublishingAccountsCapability(agentId); await authorizePublishingAccount(user, accountId, true); await requirePublishingAccount(agentId, instanceId, accountId); }
  return packagesResultSchema.parse(await rpc({ agentId, instanceId }, user.username, { kind: "publishing-packages", ...(accountId ? { accountId } : {}) }));
}
/** 编辑计划始终核对当前设备归属；管理员可协助，设备转让不能继承原客户的草稿。 */
async function authorizePlan(user: Member, plan: PublishingPlan) {
  const agent = await authorizeAgent(user, plan.profile.agentId); await requireTarget(plan.profile.agentId, plan.profile.instanceId);
  if (agent.owner && agent.owner !== plan.owner || user.role !== "admin" && plan.owner !== user.username) throw new AppError("FORBIDDEN", "计划设备或客户归属已改变。", 403);
  if (plan.profile.accountId) { await authorizePublishingAccount(user, plan.profile.accountId, true); await requirePublishingAccount(plan.profile.agentId, plan.profile.instanceId, plan.profile.accountId, plan.profile.channelId); }
  return agent;
}
/** 创建持久草稿，Profile 和包列表均固定快照；异常包须在检查步骤显式排除。 */
export async function previewPublishingPlan(user: Member, profileId: string, batchId: string, rawRule: unknown, rawItems?: PublishingPlanItem[]) {
  const state = await readState(); const record = state.profiles.find(p => p.value.id === profileId);
  if (!record) throw new AppError("PROFILE", "发布配置不存在。", 404);
  if (user.role !== "admin" && record.owner !== user.username) throw new AppError("FORBIDDEN", "配置不属于当前客户。", 403);
  const profile = structuredClone(record.value); if (!profile.accountId) throw new AppError("ACCOUNT", "新发布包计划请先选择独立发布账号并创建配置。", 409); const agent = await authorizeAgent(user, profile.agentId); const result = await publishingPackages(user, profile.agentId, profile.instanceId, profile.accountId);
  // 新批次的公开必须经过时间确认；旧配置和已建立的扁平素材任务仍按原意图执行。
  profile.scheduled = profile.privacy === "public";
  if (result.channelId !== profile.channelId) throw new AppError("CHANNEL", "授权频道与配置不同，请重新选择。");
  const batch = result.batches.find(batch => batch.id === batchId); if (!batch) throw new AppError("PACKAGE", "批次已变化，请重新读取发布目录。");
  if (!batch.packages.length) throw new AppError("PACKAGE", "批次没有可检查的发布包。");
  const plan: PublishingPlan = { id: randomUUID(), revision: 1, owner: agent.owner || user.username, actor: user.username, profile, batch: structuredClone(batch), rule: planRuleSchema.parse(rawRule), items: [], copies: [], skippedOccupied: 0, skipped: [], createdAt: Date.now() };
  return edit(async s => { await authorizePublishingWrite(user, plan.profile, plan.owner, s); if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。"); if (s.plans.some(p => p.profile.agentId === plan.profile.agentId && p.batch.id === batch.id && (p.archivedAt || p.archivePending))) throw new AppError("ARCHIVE", "批次已归档或正在等待归档确认。", 409); generatePublishingPlan(plan, rawItems || batch.packages.map(pkg => ({ packageId: pkg.id, scheduleSource: "auto", excluded: false })), s.jobs); s.plans.push(plan); return plan; });
}
/** 草稿修订使用乐观版本，刷新可继续；已确认快照只通过 Job 的控制修订修改。 */
export async function updatePublishingPlan(user: Member, id: string, revision: number, items: PublishingPlanItem[], rawRule?: unknown) {
  const old = (await readState()).plans.find(plan => plan.id === id); if (!old) throw new AppError("PLAN", "计划不存在。", 404); await authorizePlan(user, old);
  return edit(async s => { const plan = s.plans.find(plan => plan.id === id); if (!plan) throw new AppError("PLAN", "计划已清理，请刷新。", 404); await authorizePublishingWrite(user, plan.profile, plan.owner, s); if (plan.archivedAt || s.plans.some(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id && p.archivePending)) throw new AppError("ARCHIVE", "批次已归档或正在等待归档确认。", 409); if (plan.revision !== revision || plan.confirmedAt) throw new AppError("REVISION", "计划已更新或已确认，请刷新。", 409); if (rawRule !== undefined) plan.rule = planRuleSchema.parse(rawRule); generatePublishingPlan(plan, items, s.jobs); plan.revision++; return plan; });
}
/** 第四步返回设置时间后只保存改期预览；原任务仍继续执行，直到用户明确确认新时间。 */
export async function previewPublishingReschedule(user: Member, id: string, revision: number, rawRule: unknown, items?: PublishingPlanItem[]) {
  const old = (await readState()).plans.find(plan => plan.id === id); if (!old) throw new AppError("PLAN", "计划不存在。", 404); await authorizePlan(user, old);
  return edit(async s => {
    const plan = s.plans.find(plan => plan.id === id); if (!plan) throw new AppError("PLAN", "计划不存在。", 404);
    await authorizePublishingWrite(user, plan.profile, plan.owner, s);
    if (plan.archivedAt || plan.archivePending || s.plans.some(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id && p.archivePending)) throw new AppError("ARCHIVE", "批次已归档或正在等待归档确认。", 409);
    if (plan.revision !== revision) throw new AppError("REVISION", "计划已更新，请刷新预览。", 409);
    if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。");
    const value = structuredClone(plan); value.rule = planRuleSchema.parse(rawRule); value.schedulePreviewId = randomUUID(); generateConfirmedSchedule(value, items, s.jobs);
    const preview: SchedulePreview = { id: value.schedulePreviewId, planId: id, revision, actor: user.username, createdAt: Date.now(), plan: value, jobs: s.jobs.filter(job => job.spec.batchId === id).map(job => ({ id: job.spec.id, fingerprint: scheduleFingerprint(job) })) };
    s.schedulePreviews = s.schedulePreviews.filter(saved => saved.planId !== id); s.schedulePreviews.push(preview); return value;
  });
}
/** 确认改期原子修订同一批 Job；上传文件、视频关联、控制意图和原计划时间均保持可追溯。 */
export async function confirmPublishingReschedule(user: Member, id: string, revision: number, previewId: string) {
  const old = (await readState()).plans.find(plan => plan.id === id); if (!old) throw new AppError("PLAN", "计划不存在。", 404); await authorizePlan(user, old);
  const result = await edit(async s => {
    const plan = s.plans.find(plan => plan.id === id); if (!plan) throw new AppError("PLAN", "计划不存在。", 404);
    await authorizePublishingWrite(user, plan.profile, plan.owner, s);
    const preview = s.schedulePreviews.find(saved => saved.id === previewId && saved.planId === id && saved.actor === user.username);
    if (!preview || preview.revision !== revision) throw new AppError("REVISION", "改期预览已更新，请重新生成预览。", 409);
    if (preview.appliedRevision === plan.revision) return plan;
    if (plan.archivedAt || plan.archivePending || s.plans.some(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id && p.archivePending)) throw new AppError("ARCHIVE", "批次已归档或正在等待归档确认。", 409);
    if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。");
    applyConfirmedSchedule(plan, preview, s.jobs, user.username); preview.appliedRevision = plan.revision; return plan;
  });
  await audit(user.username, "publishing-plan-reschedule", old.profile.instanceId, "accepted"); return result;
}
/** 确认重扫输入版本，事务内再次核对频道 Slot；冲突只报错，绝不偷偷改动已展示时间。 */
export async function confirmPublishingPlan(user: Member, id: string, revision: number, ai: boolean, temporaryPrivateTitle: boolean, replaceJobIds: string[] = []) {
  const before = await readState(); const old = before.plans.find(plan => plan.id === id); if (!old) throw new AppError("PLAN", "计划不存在。", 404); await authorizePlan(user, old);
  if (old.confirmedAt) return before.jobs.filter(job => job.spec.batchId === id);
  if (old.archivedAt) throw new AppError("ARCHIVE", "批次已归档，未确认草稿不能再上传。", 409);
  if (!temporaryPrivateTitle || old.profile.ai.enabled && !ai) throw new AppError("CONSENT", "请同意临时私密上传和已开启的 AI 文案规则。");
  const scanned = await publishingPackages(user, old.profile.agentId, old.profile.instanceId, old.profile.accountId);
  if (scanned.channelId !== old.profile.channelId) throw new AppError("CHANNEL", "频道授权发生变化，请重新选择。");
  const currentBatch = scanned.batches.find(batch => batch.id === old.batch.id);
  if (!currentBatch || currentBatch.version !== old.batch.version) throw new AppError("PACKAGE_CHANGED", "发布包文件已变化，请重新检查并确认新版本。", 409);
  if (old.profile.thumbnailMode === "fixed" && !scanned.thumbnails?.includes(old.profile.thumbnailFilename!)) throw new AppError("THUMBNAIL", "配置要求的固定封面不存在，请在设备缩略图目录准备好文件。");
  const result = await edit(async s => {
    const plan = s.plans.find(plan => plan.id === id); if (!plan) throw new AppError("PLAN", "计划已清理，请刷新。", 404); await authorizePublishingWrite(user, plan.profile, plan.owner, s); if (plan.confirmedAt) return s.jobs.filter(job => job.spec.batchId === id);
    if (plan.archivedAt || s.plans.some(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id && p.archivePending)) throw new AppError("ARCHIVE", "批次已归档或正在等待归档确认。", 409);
    if (plan.revision !== revision) throw new AppError("REVISION", "计划已更新，请刷新预览。", 409);
    if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。");
    if (plan.profile.accountId) await requirePublishingAccount(plan.profile.agentId, plan.profile.instanceId, plan.profile.accountId, plan.profile.channelId);
    else if (s.cleanups.some(c => c.agentId === plan.profile.agentId && c.instanceId === plan.profile.instanceId && c.state === "pending")) throw new AppError("CLEANUP", "等待设备授权清理。");
    if (plan.batch.issues.length || !plan.items.some(item => !item.excluded)) throw new AppError("PACKAGE", "请处理批次问题并至少选择一个发布包。");
    const occupied = occupiedPublishingSlots(s.jobs, plan.profile.channelId); const jobs: VideoJob[] = []; const replacements = new Set(replaceJobIds);
    for (const replacement of replacements) { const previous = s.jobs.find(job => job.spec.id === replacement); if (!previous || previous.spec.profile.channelId !== plan.profile.channelId || previous.spec.profile.agentId !== plan.profile.agentId || previous.observed?.state !== "cancelled" || previous.observed.revision !== previous.spec.revision || !plan.items.some(item => !item.excluded && item.packageId === previous.spec.contentPackage?.id && plan.batch.packages.find(pkg => pkg.id === item.packageId)?.version !== previous.spec.contentPackage?.version)) throw new AppError("REPLACEMENT", "替代任务必须对应已确认取消的旧包及明确确认的新版本。", 409); }
    for (const [index, item] of plan.items.entries()) {
      if (item.excluded) continue;
      const pkg = plan.batch.packages.find(pkg => pkg.id === item.packageId)!;
      if (pkg.validationState !== "valid" || !pkg.sourceVideo) throw new AppError("PACKAGE", "请处理或排除异常发布包：" + pkg.name);
      if (plan.profile.scheduled && (!item.publishAt || Date.parse(item.publishAt) <= Date.now())) throw new AppError("CONFLICT", "预览中的时间已过去，请重新生成预览。", 409);
      if (item.publishAt && occupied.has(Date.parse(item.publishAt))) throw new AppError("CONFLICT", "该频道时刻已被另一计划占用，请刷新预览。", 409);
      if (item.publishAt) occupied.add(Date.parse(item.publishAt));
      const previous = s.jobs.filter(job => job.spec.profile.channelId === plan.profile.channelId && job.spec.profile.agentId === plan.profile.agentId && job.spec.contentPackage?.id === pkg.id);
      if (previous.some(job => !replacements.has(job.spec.id) && (job.observed?.state !== "cancelled" || job.observed.revision !== job.spec.revision || job.hadUpload))) throw new AppError("DUPLICATE", "该发布包已有上传记录；先核对并取消旧任务，可能已上传的新版本需明确确认替代上传。", 409);
      const spec = jobSpecSchema.parse({ id: randomUUID(), batchId: plan.id, owner: plan.owner, actor: user.username, revision: 1, desired: "run", asset: pkg.sourceVideo, contentPackage: pkg, plan: plan.rule, scheduleSource: item.scheduleSource, profile: plan.profile, index: index + 1, originalPublishAt: item.publishAt, overrides: { ...(item.title !== undefined ? { title: item.title } : {}), ...(item.description !== undefined ? { description: item.description } : {}) }, policy: s.policy, consent: { version: PRIVACY_VERSION, acceptedAt: Date.now(), ai, temporaryPrivateTitle: true } });
      if (!spec.profile.ai.enabled) await publishingMetadata(publishingStore(), spec);
      jobs.push({ spec, initialPublishAt: item.publishAt, createdAt: Date.now() });
    }
    plan.confirmedAt = Date.now(); s.jobs.push(...jobs); return jobs;
  });
  await audit(user.username, "publishing-plan-confirm", old.profile.instanceId, "succeeded"); return result;
}
/** 整批所有计划和任务确实完成才允许搬移；离线/未知结果持久显示 pending，重试同一个归档 ID。 */
export async function archivePublishingPlan(user: Member, id: string) {
  const plan = (await readState()).plans.find(plan => plan.id === id); if (!plan) throw new AppError("PLAN", "计划不存在。", 404); await authorizePlan(user, plan);
  if (plan.archivedAt) return { state: "complete" as const, destination: plan.archiveDestination || "" };
  await edit(async s => {
    const saved = s.plans.find(value => value.id === id); if (!saved) throw new AppError("PLAN", "计划已清理，请刷新。", 404); await authorizePublishingWrite(user, saved.profile, saved.owner, s);
    const related = s.plans.filter(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id);
    if (related.some(p => p.id !== id && p.archivePending)) throw new AppError("ARCHIVE_BUSY", "批次正在归档，请在原计划核对归档。", 409);
    const relatedIds = new Set(related.map(p => p.id)); const jobs = s.jobs.filter(job => relatedIds.has(job.spec.batchId));
    const completed = jobs.filter(job => ["published", "completed"].includes(job.observed?.state || "") && job.observed?.revision === job.spec.revision && (job.spec.profile.privacy !== "public" || job.observed.state === "published" || job.observed.observedPrivacy === "public"));
    if (plan.batch.issues.length || plan.batch.packages.some(pkg => pkg.validationState !== "valid" || !completed.some(job => job.spec.contentPackage?.id === pkg.id && job.spec.contentPackage.version === pkg.version))) throw new AppError("ARCHIVE", "整批当前版本须全部在 YouTube 真正完成，暂不发布包仍需处理。", 409);
    if (jobs.some(job => !completed.includes(job) && !(job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision))) throw new AppError("ARCHIVE", "批次仍有活动或未核对的任务，不能移动源文件。", 409);
    s.plans.find(p => p.id === id)!.archivePending = true;
  });
  try {
    await requireTarget(plan.profile.agentId, plan.profile.instanceId, true);
    const result = await rpc<{ state: "complete"; destination: string }>({ agentId: plan.profile.agentId, instanceId: plan.profile.instanceId }, user.username, { kind: "publishing-archive", batch: plan.batch, archiveId: plan.id, ...(plan.profile.accountId ? { accountId: plan.profile.accountId } : {}) });
    if (result.state !== "complete" || !result.destination) throw new AppError("ARCHIVE", "设备尚未确认归档。");
    await edit(s => { for (const p of s.plans.filter(p => p.profile.agentId === plan.profile.agentId && p.batch.id === plan.batch.id)) { p.archivePending = false; p.archivedAt = Date.now(); p.archiveDestination = result.destination; } });
    await audit(user.username, "publishing-plan-archive", plan.profile.instanceId, "succeeded"); return result;
  } catch (error) {
    // RPC 将设备原因保留在严格 Problem 中；只接受明确证明源目录尚未移动的拒绝。
    if (isAppError(error) && ["ARCHIVE_SOURCE_CHANGED", "ARCHIVE_CONFLICT"].includes(error.problem?.code || error.code)) await edit(s => { const saved = s.plans.find(p => p.id === id); if (saved && !saved.archivedAt) saved.archivePending = false; });
    if (isAppError(error) && !["AGENT_OFFLINE", "AGENT_TIMEOUT"].includes(error.code)) throw error;
    return { state: "pending" as const, message: isAppError(error) ? error.message : "设备尚未确认归档，请连接后重试。" };
  }
}
/** 服务端生成持久预览；确认只能引用这个快照，浏览器不能更换文件属性或频道。 */
export async function previewPublishingBatch(user: Member, profileId: string, assetIds: string[]) {
  const state = await readState(); const profile = state.profiles.find(p => p.value.id === profileId)?.value;
  if (!profile) throw new AppError("PROFILE", "发布配置不存在。", 404);
  if (user.role !== "admin" && state.profiles.find(p => p.value.id === profileId)?.owner !== user.username) throw new AppError("FORBIDDEN", "配置不属于当前客户。", 403);
  const agent = await authorizeAgent(user, profile.agentId);
  if (!assetIds.length || assetIds.length > 1000 || new Set(assetIds).size !== assetIds.length) throw new AppError("INPUT", "请选择 1–1000 个不同视频。");
  const result = await publishingAssets(user, profile.agentId, profile.instanceId, profile.accountId);
  if (result.channelId !== profile.channelId) throw new AppError("CHANNEL", "当前授权频道与 Profile 不一致。");
  const assets = assetIds.map(id => { const asset = result.assets.find(a => a.id === id); if (!asset) throw new AppError("ASSET", "所选视频已变化，请重新扫描。"); return asset; });
  if (profile.thumbnailMode === "fixed" && !result.thumbnails.includes(profile.thumbnailFilename!)) throw new AppError("THUMBNAIL", "固定缩略图不存在。");
  const scheduled = profile.scheduled ? scheduleSlots(profile.schedule, assets.length) : { slots: [], skipped: [] };
  const copies = assets.map((asset, index) => { const context = { asset, index: index + 1, profile, originalPublishAt: scheduled.slots[index]?.publishAt } as JobSpec; return { title: expandTemplate(profile.ai.enabled ? profile.ai.fallbackTitle : profile.titleTemplate, context), description: expandTemplate(profile.ai.enabled ? profile.ai.fallbackDescription : profile.descriptionTemplate, context) }; });
  const batch: Batch = { id: randomUUID(), owner: agent.owner || user.username, actor: user.username, profile: structuredClone(profile), assets, thumbnails: result.thumbnails, copies, ...scheduled, createdAt: Date.now() };
  await edit(async s => { await authorizePublishingWrite(user, batch.profile, batch.owner, s); if (s.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请先同意隐私政策。"); s.batches = s.batches.filter(b => b.confirmedAt || b.createdAt > Date.now() - 86400_000); s.batches.push(batch); });
  return batch;
}
/** 批次确认幂等；Profile 和顺序固定，阻止同素材/同频道活动重复及计划时刻冲突。 */
export async function confirmPublishingBatch(user: Member, id: string, ai: boolean, temporaryPrivateTitle: boolean, overrides: ItemOverride[] = []) {
  const before = await readState(); const batch = before.batches.find(b => b.id === id); if (!batch) throw new AppError("BATCH", "排期预览已过期，请重新预览。");
  const agent = await authorizeAgent(user, batch.profile.agentId);
  if (agent.owner && agent.owner !== batch.owner || user.role !== "admin" && batch.actor !== user.username) throw new AppError("FORBIDDEN", "排期归属已改变。", 403);
  if (!temporaryPrivateTitle || batch.profile.ai.enabled && !ai) throw new AppError("CONSENT", "请明确同意临时私密上传与所选 AI 自动文案规则。");
  const result = await edit(async state => {
    const saved = state.batches.find(b => b.id === id); if (!saved) throw new AppError("BATCH", "排期预览已清理，请重新预览。", 404); await authorizePublishingWrite(user, saved.profile, saved.owner, state);
    if (saved.confirmedAt) return state.jobs.filter(j => j.spec.batchId === id);
    if (saved.profile.accountId) await requirePublishingAccount(saved.profile.agentId, saved.profile.instanceId, saved.profile.accountId, saved.profile.channelId);
    else if (state.cleanups.some(c => c.agentId === saved.profile.agentId && c.instanceId === saved.profile.instanceId && c.state === "pending")) throw new AppError("CLEANUP", "设备授权清理尚未完成。");
    if (overrides.some(v => !saved.assets.some(a => a.id === v.assetId)) || new Set(overrides.map(v => v.assetId)).size !== overrides.length) throw new AppError("INPUT", "逐项覆盖必须对应本批次的不重复素材。");
    if (state.consents[user.username]?.version !== PRIVACY_VERSION) throw new AppError("PRIVACY", "请重新同意隐私政策。");
    const jobs: VideoJob[] = [];
    for (const [index, asset] of saved.assets.entries()) {
      const override = overrides.find(v => v.assetId === asset.id); const thumbnail = override?.thumbnail || asset.thumbnail;
      if (override?.thumbnail && !saved.thumbnails.includes(override.thumbnail) || saved.profile.thumbnailMode === "matching" && !thumbnail) throw new AppError("THUMBNAIL", "请为视频选择已准备的缩略图：" + asset.filename);
      const at = saved.slots[index]?.publishAt;
      if (state.jobs.some(j => (j.hadUpload || !["cancelled", "failed"].includes(j.observed?.state || "")) && j.spec.profile.channelId === saved.profile.channelId && (j.spec.asset.version === asset.version || asset.sha256 && j.spec.asset.sha256 === asset.sha256 || at && j.spec.originalPublishAt === at))) throw new AppError("DUPLICATE", "同频道已有相同素材任务或排期时刻，请先核对原任务。");
      const spec = jobSpecSchema.parse({ id: randomUUID(), batchId: id, owner: saved.owner, actor: saved.actor, revision: 1, desired: "run", asset: { ...asset, ...(thumbnail ? { thumbnail } : {}) }, profile: saved.profile, index: index + 1, originalPublishAt: at, overrides: { ...(override?.title !== undefined ? { title: override.title } : {}), ...(override?.description !== undefined ? { description: override.description } : {}) }, policy: state.policy, consent: { version: PRIVACY_VERSION, acceptedAt: Date.now(), ai, temporaryPrivateTitle: true } });
      // AI 不在 Cloud 执行；非 AI 模板在确认时即可发现无效文案。
      if (!spec.profile.ai.enabled) await publishingMetadata(publishingStore(), spec);
      jobs.push({ spec, initialPublishAt: at, createdAt: Date.now() });
    }
    saved.confirmedAt = Date.now(); state.jobs.push(...jobs); return jobs;
  });
  await audit(user.username, "publishing-confirm", batch.profile.instanceId, "succeeded"); return result;
}
/** 用户控制先保存 desired/revision；改期保留暂停意图，需人工处理或取消中的任务不能接受无法应用的新时间。 */
export async function changePublishingJob(user: Member, id: string, action: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) {
  const state = await readState(); const old = state.jobs.find(j => j.spec.id === id); if (!old) throw new AppError("JOB", "任务不存在。", 404);
  const agent = await authorizeAgent(user, old.spec.profile.agentId); if (agent.owner && agent.owner !== old.spec.owner) throw new AppError("FORBIDDEN", "任务设备归属已变更。", 403);
  if (old.spec.profile.accountId) { await authorizePublishingAccount(user, old.spec.profile.accountId, true); await requirePublishingAccount(old.spec.profile.agentId, old.spec.profile.instanceId, old.spec.profile.accountId, old.spec.profile.channelId); }
  const result = await edit(async s => {
    const job = s.jobs.find(j => j.spec.id === id); if (!job) throw new AppError("JOB", "任务已清理，请刷新。", 404); await authorizePublishingWrite(user, job.spec.profile, job.spec.owner, s);
    if (publishingTerminal(job.observed?.state) && action !== "reconcile") throw new AppError("TERMINAL", "任务已结束；已公开视频请在 Studio 管理。");
    // 上传 admission 在 begin 请求前持久化 hadUpload；尚未开始的任务没有远端对象，不投递新执行入口。
    if (action === "reconcile" && !job.hadUpload && !job.observed?.videoId) throw new AppError("VIDEO_NOT_UPLOADED", "视频尚未上传，暂无远端状态可核对。", 409);
    if (action === "reschedule") {
      if (!job.spec.profile.scheduled || !publishAt || !Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt) <= Date.now()) throw new AppError("INPUT", "请选择未来的有效定时公开时刻。");
      if (!scheduleEditable(job)) throw new AppError("RESCHEDULE_BLOCKED", job.spec.desired === "cancel" ? "任务正在取消，请等待设备确认。" : "请先核对并解决任务异常，再改期。", 409);
      if (occupiedPublishingSlots(s.jobs, job.spec.profile.channelId, id).has(Date.parse(publishAt))) throw new AppError("DUPLICATE", "该频道排期时刻已占用。");
      job.pendingPublishAts = [...new Set([...(job.pendingPublishAts || []), job.pendingPublishAt, job.observed?.effectivePublishAt, job.spec.originalPublishAt].filter((at): at is string => !!at))];
      job.pendingPublishAt ??= job.observed?.effectivePublishAt || job.spec.originalPublishAt; job.spec.originalPublishAt = publishAt;
      if (job.spec.contentPackage) { job.spec.scheduleSource = "manual"; const plan = s.plans.find(plan => plan.id === job.spec.batchId); const item = plan?.items.find(item => item.packageId === job.spec.contentPackage!.id); if (plan && item) { item.publishAt = publishAt; item.scheduleSource = "manual"; plan.revision++; } }
    }
    job.spec.revision++;
    if (action === "reconcile") { job.spec.reconcileRevision = job.spec.revision; job.spec.reconcileTotal = job.prepared?.size || job.observed?.total || job.spec.asset.size; }
    else { if (action !== "reschedule") job.spec.desired = action === "pause" ? "pause" : action === "cancel" ? "cancel" : "run"; if (action === "resume") job.spec.policy = s.policy; delete job.spec.reconcileRevision; delete job.spec.reconcileTotal; }
    return job;
  });
  await audit(user.username, "publishing-" + action, old.spec.profile.instanceId, "accepted"); return result;
}
/** Agent 报告按 revision/sequence 核对；上传事实单调保存，不能因 API 数据过期允许重复新建。 */
export async function reportPublishing(agentId: string, values: PublishingReport[]) {
  return edit(async s => Promise.all(values.map(async report => {
    const job = s.jobs.find(j => j.spec.id === report.id);
    if (!job) return { id: report.id, sequence: report.sequence };
    if (job.spec.profile.agentId !== agentId || report.revision > job.spec.revision) throw new AppError("REPORT", "发布报告目标或版本无效。", 403);
    if (uploadObserved(report)) job.hadUpload = true;
    if (job.observed && job.observed.sequence >= report.sequence) return { id: report.id, sequence: report.sequence };
    if (report.prepared) {
      if (job.prepared && (job.prepared.size !== report.prepared.size || job.prepared.version !== report.prepared.version || job.prepared.sha256 !== report.prepared.sha256)) throw new AppError("REPORT", "已固定的最终上传文件不可被替换。", 409);
      if (!job.prepared && (job.spec.contentPackage ? report.offset !== 0 : report.prepared.size !== job.spec.asset.size)) throw new AppError("REPORT", "上传进度前必须先确认最终文件。", 409);
      job.prepared ??= report.prepared;
    }
    if (report.total !== (job.prepared?.size || job.spec.asset.size) || report.offset > report.total || job.spec.contentPackage && report.offset > 0 && !job.prepared) throw new AppError("REPORT", "发布报告的最终文件或进度无效。", 403);
    if (report.authorizationInvalid) { if (job.spec.profile.accountId) { await beginPublishingAccountCleanup(agentId, job.spec.profile.accountId, job.spec.actor); removePublishingAccountData(s, job.spec.profile.accountId); } else beginCleanup(s, agentId, job.spec.profile.instanceId, job.spec.owner, job.spec.actor); return { id: report.id, sequence: report.sequence }; }
    if (!job.observed || job.observed.sequence < report.sequence) { job.observed = report; delete job.blockReason; delete job.budgetWaiting; if (report.revision === job.spec.revision && ["scheduled", "published", "completed", "cancelled"].includes(report.state)) { delete job.pendingPublishAt; delete job.pendingPublishAts; } if (report.revision === job.spec.revision && (publishingTerminal(report.state) || ["scheduled", "paused", "needs_attention"].includes(report.state))) for (const budget of Object.values(s.quota)) delete budget.reservations?.[job.spec.id]; }
    return { id: report.id, sequence: report.sequence };
  })));
}
/** 对每次实际 API 调用先持久化 admission；未知远端结果不退回预算。 */
export async function chargePublishing(agentId: string, id: string, receipt: string, units: number, upload: boolean) {
  const machine = (await listAgents()).find(a => a.id === agentId);
  return edit(async s => {
    const job = s.jobs.find(j => j.spec.id === id); if (!job || job.spec.profile.agentId !== agentId) throw new AppError("FORBIDDEN", "发布任务不属于此设备。", 403);
    if (!machine || machine.revoked || machine.owner && machine.owner !== job.spec.owner) throw new AppError("FORBIDDEN", "设备归属已改变，停止新发布 API 操作。", 403);
    if (job.spec.profile.accountId) await requirePublishingAccount(agentId, job.spec.profile.instanceId, job.spec.profile.accountId, job.spec.profile.channelId);
    const budget = quotaBudget(s, job.spec.policy.projectKey);
    if (budget.receipts.includes(receipt)) return { ok: true };
    const others = reserved(budget, job.spec.id); const own = budget.reservations![job.spec.id];
    if (budget.uploads + others.uploads + Math.max(Number(upload), own?.uploads || 0) > s.policy.uploadsPerDay || budget.units + others.units + Math.max(units, own?.units || 0) > s.policy.otherUnitsPerDay) throw new AppError("VIDEO_QUOTA", "普通发布的项目预算已用完，等待太平洋时间配额日重置。", 503);
    if (own) { own.uploads = Math.max(0, own.uploads - Number(upload)); own.units = Math.max(0, own.units - units); }
    if (upload) job.hadUpload = true;
    budget.uploads += Number(upload); budget.units += units; budget.receipts.push(receipt); return { ok: true };
  });
}
/** 删除请求持久保存到设备确认；立即停止新派发并移除 Cloud 发布数据。 */
export async function requestPublishingCleanup(user: Member, agentId: string, instanceId: string) {
  const agent = await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId);
  const cleanup = await edit(s => beginCleanup(s, agentId, instanceId, agent.owner || user.username, user.username));
  const store = agentStore(agentId); await transaction(store, async () => { const queue = await store.read<{ records: { kind: string; instanceId: string; payload: string }[] }>("tasks.json"); if (queue) { queue.records = queue.records.filter(r => r.instanceId !== instanceId || !r.kind.startsWith("publishing-") || !!publishingTaskAccountId(unseal<TaskPayload>(r.payload))); await store.write("tasks.json", queue); } }, "tasks.lock");
  await audit(user.username, "youtube-data-delete", instanceId, "accepted"); return cleanup;
}
/** 启动/重连后在普通指令之前取得待撤销任务。 */
export async function publishingCleanups(agentId: string) { const accounts = (await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-accounts-v1") ? await publishingAccountCleanups(agentId) : []; return [...(await readState()).cleanups.filter(c => c.agentId === agentId && c.state === "pending").map(c => ({ id: c.id, instanceId: c.instanceId, createdAt: c.createdAt })), ...accounts.filter(c => c.state === "pending").map(c => ({ id: c.id, accountId: c.accountId, instanceId: c.instanceId, createdAt: c.createdAt }))]; }
/** 所有已授权数据已被 Agent 清理且 Google 撤销确认后才显示完成。 */
export async function completePublishingCleanup(agentId: string, id: string) {
  const accountCleanup = (await publishingAccountCleanups(agentId)).find(cleanup => cleanup.id === id);
  if (accountCleanup) { await requirePublishingAccountsCapability(agentId); await edit(s => removePublishingAccountData(s, accountCleanup.accountId)); await purgePublishingAccountTasks(agentId, accountCleanup.accountId); return completePublishingAccountCleanup(agentId, id); }
  const cleanup = (await readState()).cleanups.find(c => c.id === id && c.agentId === agentId); if (!cleanup) throw new AppError("CLEANUP", "清理请求不存在。");
  const store = cloudStore(); await transaction(store, async () => { const bindings = await store.read<{ agentId: string; instanceId: string }[]>("bindings.json"); if (bindings) await store.write("bindings.json", bindings.filter(b => b.agentId !== agentId || b.instanceId !== cleanup.instanceId)); });
  const local = agentStore(agentId); await transaction(local, async () => { const queue = await local.read<{ records: { instanceId: string; kind: string; status: string; payload: string }[] }>("tasks.json"); if (queue) { queue.records = queue.records.filter(r => r.instanceId !== cleanup.instanceId || !!publishingTaskAccountId(unseal<TaskPayload>(r.payload)) || !(r.kind.startsWith("publishing-") || r.kind.startsWith("oauth-") || ["broadcast-playlists", "broadcast-read", "control"].includes(r.kind))); await local.write("tasks.json", queue); } }, "tasks.lock");
  const heartbeat = await local.read<{ snapshots: { instance: { id: string }; dashboard: { youtube: unknown; state: Record<string, unknown> } }[] }>("heartbeat.json");
  if (heartbeat) { for (const snapshot of heartbeat.snapshots) if (snapshot.instance.id === cleanup.instanceId) { snapshot.dashboard.youtube = { connected: false, authorization: "missing" }; for (const key of ["channelId", "broadcastId", "streamId", "broadcastTitle", "streamTitle"]) delete snapshot.dashboard.state[key]; } await local.write("heartbeat.json", heartbeat); }
  await edit(s => { const c = s.cleanups.find(c => c.id === id && c.agentId === agentId)!; c.state = "complete"; c.completedAt = Date.now(); }); return { ok: true };
}
/** 隐私页只公开运营者配置的联系信息，不能公开任务、频道或项目凭据。 */
export async function publishingPrivacyContact() { return (await readState()).policy.privacyContact || "尚未配置，请联系为您分配设备的管理员。"; }
/** 删除只清除同一独立账号的 Cloud 记录，保留其他账号、直播及用户本地源文件。 */
function removePublishingAccountData(s: State, accountId: string) {
  for (const job of s.jobs.filter(job => job.spec.profile.accountId === accountId)) for (const budget of Object.values(s.quota)) delete budget.reservations?.[job.spec.id];
  s.jobs = s.jobs.filter(job => job.spec.profile.accountId !== accountId); s.profiles = s.profiles.filter(profile => profile.value.accountId !== accountId); s.plans = s.plans.filter(plan => plan.profile.accountId !== accountId); s.batches = s.batches.filter(batch => batch.profile.accountId !== accountId); s.schedulePreviews = s.schedulePreviews.filter(preview => preview.plan.profile.accountId !== accountId);
}
/** 加密投递按真实 accountId 过滤，不能按 instanceId 删除同设备其他发布账号的任务。 */
async function purgePublishingAccountTasks(agentId: string, accountId: string) {
  const store = agentStore(agentId); await transaction(store, async () => { const queue = await store.read<{ records: { payload: string }[] }>("tasks.json"); if (queue) { queue.records = queue.records.filter(record => publishingTaskAccountId(unseal<TaskPayload>(record.payload)) !== accountId); await store.write("tasks.json", queue); } }, "tasks.lock");
}
/** 用户删除可在离线时提交，执行确认通过原 Agent 清理协议返回，审计只记录安全结果。 */
export async function requestPublishingAccountCleanup(user: Member, accountId: string) {
  const cleanup = await accountCleanup(user, accountId); await edit(s => removePublishingAccountData(s, accountId)); await purgePublishingAccountTasks(cleanup.agentId, accountId); await audit(user.username, "publishing-account-delete", cleanup.instanceId, "accepted"); return cleanup;
}
/** 云服务 tick：只派发窗口内任务，离线保留，任务修订与投递幂等 ID 独立。 */
export async function publishingTick() {
  await expirePublishingAccountData();
  for (const cleanup of (await publishingAccountCleanups()).filter(cleanup => cleanup.state === "pending")) await edit(s => removePublishingAccountData(s, cleanup.accountId));
  const state = await readState(); const agents = await listAgents();
  for (const job of state.jobs) {
    const p = job.spec.profile; const agent = agents.find(a => a.id === p.agentId);
    if (!agent || agent.revoked || agent.owner && agent.owner !== job.spec.owner || !agent.online || agent.maintenance) continue;
    if (job.spec.reconcileRevision !== job.spec.revision && job.spec.desired === "run" && (publishingTerminal(job.observed?.state) && job.observed?.revision === job.spec.revision || !job.observed?.videoId && job.spec.originalPublishAt && Date.parse(job.spec.originalPublishAt) > Date.now() + (job.spec.plan?.preuploadDays ?? p.schedule.preuploadDays) * 86400_000)) continue;
    const capabilities = await agentStore(p.agentId).read<string[]>("capabilities.json");
    if (p.accountId) { if (!capabilities?.includes("publishing-accounts-v1")) continue; try { await requirePublishingAccount(p.agentId, p.instanceId, p.accountId, p.channelId); } catch { continue; } }
    if (!capabilities?.includes(job.spec.contentPackage ? "publishing-v2" : "publishing-v1")) continue;
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
