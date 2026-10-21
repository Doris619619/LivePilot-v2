/** 独立发布账号的 Cloud 归属、频道占位和删除确认；不持有 OAuth Token，也不修改直播绑定。 */
import { randomUUID } from "node:crypto";
import type { Member } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { AppError } from "@/core/errors";
import { publishingAccountSchema, type PublishingAccount, type PublishingAccountReport } from "@/shared/publishing";
import { agentStore, listAgents, requireTarget } from "./agents";
import { cloudStore, transaction } from "./store";

export type PublishingAccountCleanup = { id: string; accountId: string; owner: string; actor: string; agentId: string; instanceId: string; createdAt: number; deadline: number; state: "pending" | "complete"; completedAt?: number };
type AuthorizationAttempt = { epoch: string; generation?: string; writePossible: boolean; previous?: { generation?: string; channelId: string; connectedAt?: number } };
type AccountRecord = { value: PublishingAccount; reauthorizationEpoch?: string; authorizationGeneration?: string; authorizationFailures?: Record<string, string>; authorizationAttempt?: AuthorizationAttempt; candidateChannelId?: string; candidateChannel?: string; candidateCheckedAt?: number; claimedAt?: number };
type AccountState = { accounts: AccountRecord[]; cleanups: PublishingAccountCleanup[] };
const file = "publishing-accounts.json";

/** 全局账号文件与设备身份变更使用同一 metadata.lock，防止撤销或转让期间重新绑定。 */
async function edit<T>(fn: (state: AccountState) => Promise<T> | T) {
  const store = cloudStore();
  return transaction(store, async () => { const state = await readState(); const value = await fn(state); await store.write(file, state); return value; });
}
/** 缺文件是尚未创建独立账号；损坏文件不能被当作空账号列表。 */
async function readState() { const state = await cloudStore().read<AccountState>(file) || { accounts: [], cleanups: [] }; expireChannelNames(state); return state; }
/** API 频道名只按真实 channels 请求时间保留30天，心跳和 Token 刷新均不续期。 */
function expireChannelNames(state: AccountState) {
  for (const record of state.accounts) {
    if (!record.value.channelCheckedAt || record.value.channelCheckedAt <= Date.now() - 30 * 86400_000) delete record.value.channel;
    if (!record.candidateCheckedAt || record.candidateCheckedAt <= Date.now() - 30 * 86400_000) delete record.candidateChannel;
  }
}
/** Scheduler 持久删除到期 API 名称；当前页面读取也不能返回已经过期的缓存。 */
export async function expirePublishingAccountData() { return edit(state => expireChannelNames(state)); }
/** 旧 Agent 可以继续直播和旧任务；新独立账号必须明确声明协议能力。 */
export async function requirePublishingAccountsCapability(agentId: string) {
  if (!(await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-accounts-v1")) throw new AppError("AGENT_VERSION", "请升级这台电脑的 Agent 以连接独立发布账号。", 409);
}
/** Browser 列表按当前设备与创建客户双重归属隔离，管理员可协助，但不回传内部占位。 */
export async function publishingAccounts(user: Member) {
  const agents = await listAgents(); const allowed = new Set(agents.filter(agent => user.role === "admin" || agent.owner === user.username).map(agent => agent.id));
  return (await readState()).accounts.filter(record => allowed.has(record.value.agentId) && (user.role === "admin" || record.value.owner === user.username)).map(record => publishingAccountSchema.parse(record.value));
}
/** Agent 同步只读取自己设备的安全绑定；清理状态不会被旧本机记录复活。 */
export async function agentPublishingAccounts(agentId: string) { return (await readState()).accounts.filter(record => record.value.agentId === agentId).map(record => publishingAccountSchema.parse(record.value)); }
/** 当前用户不能用设备转让后的旧账号或已删除账号创建新请求。 */
export async function authorizePublishingAccount(user: Member, id: string, connected = false) {
  const account = (await readState()).accounts.find(record => record.value.id === id)?.value;
  if (!account) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
  const agent = await authorizeAgent(user, account.agentId); await requireTarget(account.agentId, account.instanceId);
  if (agent.owner && agent.owner !== account.owner || user.role !== "admin" && account.owner !== user.username) throw new AppError("FORBIDDEN", "发布账号的客户归属已改变。", 403);
  if (account.status === "deleted") throw new AppError("ACCOUNT", "发布账号已删除，请新建账号。", 409);
  if (account.status === "cleanup_pending") throw new AppError("CLEANUP", "等待设备清理此发布账号。", 409);
  if (connected && (account.status !== "connected" || !account.channelId)) throw new AppError("CHANNEL", "请先连接这个发布账号的 YouTube 频道。", 409);
  return publishingAccountSchema.parse(account);
}
/** 上传、配额和设备指令均重新检查独立账号目标，不能回落到同实例的直播凭据。 */
export async function requirePublishingAccount(agentId: string, instanceId: string, id: string, channelId?: string, connected = true) {
  const account = await requirePublishingAccountOwner(agentId, instanceId, id);
  if (account.status === "cleanup_pending" || account.status === "deleted") throw new AppError("CLEANUP", "此发布账号正在清理或已删除。", 409);
  if (connected && (account.status !== "connected" || !account.channelId) || channelId && account.channelId !== channelId) throw new AppError("CHANNEL", "发布账号未连接或频道与任务快照不同。", 409);
  if (connected) await requirePublishingAuthorizationCapability(agentId, id);
  return publishingAccountSchema.parse(account);
}
/** 进入新凭据代次协议的账号不能由降级Agent回到无代次联网；清理撤销走原请求例外，不经过此检查。 */
export async function requirePublishingAuthorizationCapability(agentId: string, id: string) {
  const record = (await readState()).accounts.find(record => record.value.id === id && record.value.agentId === agentId);
  if (record?.authorizationGeneration && !(await agentStore(agentId).read<string[]>("capabilities.json"))?.includes("publishing-auth-generation-v1")) throw new AppError("AGENT_VERSION", "此发布账号已启用授权恢复保护，请升级直播电脑的 Agent 后继续。", 409);
}
/** 生命周期准入先核对有效设备和当前客户归属；是否可调用具体方法由调用方另行校验，不能当作可发送证明。 */
export async function requirePublishingAccountOwner(agentId: string, instanceId: string, id: string) {
  const account = (await readState()).accounts.find(record => record.value.id === id)?.value;
  const agent = await requireTarget(agentId, instanceId);
  if (!account || account.agentId !== agentId || account.instanceId !== instanceId || agent.owner && agent.owner !== account.owner) throw new AppError("ACCOUNT", "发布账号不属于该设备或客户。", 403);
  return publishingAccountSchema.parse(account);
}
/** 事后事件只读历史路由，清理及删除不抹去归属；不授予新的Google调用，也不吞掉存储错误。 */
export async function ownsPublishingAccountHistory(agentId: string, instanceId: string, id: string) {
  return (await readState()).accounts.some(record => record.value.id === id && record.value.agentId === agentId && record.value.instanceId === instanceId);
}
/** 账号可先建立路由，只有用户主动连接才触发 OAuth；名称不参与 Token 定位。 */
export async function createPublishingAccount(user: Member, agentId: string, instanceId: string, name: string) {
  await requirePublishingAccountsCapability(agentId);
  return edit(async state => {
    const agent = await authorizeAgent(user, agentId); await requireTarget(agentId, instanceId);
    const account = publishingAccountSchema.parse({ id: randomUUID(), agentId, instanceId, name, owner: agent.owner || user.username, status: "unbound", createdAt: Date.now(), updatedAt: Date.now() });
    state.accounts.push({ value: account }); return account;
  });
}
/** Agent 在保存 Token 前永久占位，再确认同一频道；重复回报恢复原占位，不推断写入是否成功。 */
export async function claimPublishingAccount(agentId: string, accountId: string, instanceId: string, channelId: string, channel: string | undefined, confirm: boolean, channelCheckedAt?: number, authorization?: { epoch?: string; generation?: string }) {
  return edit(async state => {
    const agent = await requireTarget(agentId, instanceId); const record = state.accounts.find(record => record.value.id === accountId); const account = record?.value;
    if (!record || !account || account.agentId !== agentId || account.instanceId !== instanceId || agent.owner && account.owner !== agent.owner) throw new AppError("ACCOUNT", "发布账号目标或客户归属无效。", 403);
    if (["cleanup_pending", "deleted"].includes(account.status)) throw new AppError("CLEANUP", "此账号正在清理，不能重新保存授权。", 409);
    if (!confirm && (authorization?.generation || record.authorizationGeneration || record.authorizationAttempt?.generation)) {
      if (!authorization?.epoch || !authorization.generation) throw new AppError("AGENT_VERSION", "请升级直播电脑的 Agent 后保存发布授权，以保护取消和异常恢复。", 409);
      if (record.reauthorizationEpoch !== authorization.epoch || record.authorizationAttempt?.generation !== authorization.generation) throw new AppError("OAUTH_SUPERSEDED", "此授权已被更新的连接替代，不能保存凭据。", 409);
    }
    if (account.channelId && account.channelId !== channelId || record.candidateChannelId && record.candidateChannelId !== channelId) throw new AppError("CHANNEL", "重新授权必须使用原发布频道；其他频道请新建发布账号。", 409);
    if (state.accounts.some(other => other.value.id !== accountId && other.value.status !== "deleted" && (other.value.channelId === channelId || other.candidateChannelId === channelId))) throw new AppError("CHANNEL_IN_USE", "该频道已绑定到另一个发布账号。", 409);
    if (channelCheckedAt !== undefined && (!Number.isFinite(channelCheckedAt) || channelCheckedAt < 0 || channelCheckedAt > Date.now() + 60_000)) throw new AppError("REPORT", "频道 API 核对时间无效。", 409);
    // Agent只有拿到此持久确认后才写Token；即使后续写入/回报失败，也不能将本次取消当成凭据未变。
    if (!confirm && record.authorizationAttempt) record.authorizationAttempt.writePossible = true;
    record.candidateChannelId = channelId; record.claimedAt ??= Date.now(); account.updatedAt = Date.now();
    if (channel && channelCheckedAt !== undefined && channelCheckedAt > Date.now() - 30 * 86400_000 && channelCheckedAt >= (account.channelCheckedAt || 0)) { record.candidateChannel = channel; record.candidateCheckedAt = channelCheckedAt; account.channelCheckedAt = channelCheckedAt; if (confirm) account.channel = channel; }
    if (confirm && (account.status !== "needs_reauthorization")) { account.channelId = channelId; account.status = "connected"; account.connectedAt ??= Date.now(); if (record.candidateChannel && record.candidateCheckedAt && record.candidateCheckedAt > Date.now() - 30 * 86400_000) { account.channel = record.candidateChannel; account.channelCheckedAt = record.candidateCheckedAt; } }
    return { ok: true };
  });
}
/** 本机重启后只能核对 Cloud 已建立的账号；缺失频道不删除已有绑定，待清理账号保持不可用。 */
export async function syncPublishingAccounts(agentId: string, reports: PublishingAccountReport[]) {
  for (const report of reports) {
    const account = (await readState()).accounts.find(record => record.value.id === report.id)?.value;
    if (!account || account.agentId !== agentId || account.instanceId !== report.instanceId) throw new AppError("ACCOUNT", "本机发布账号报告不属于此设备。", 403);
    if (["cleanup_pending", "deleted"].includes(account.status)) continue;
    if (report.cleanupPending) { await beginPublishingAccountCleanup(agentId, report.id, account.owner); continue; }
    if (account.status === "needs_reauthorization") continue;
    if (report.channelId && !report.cleanupPending) await claimPublishingAccount(agentId, report.id, report.instanceId, report.channelId, report.channel, true, report.channelCheckedAt);
    else if (account.status === "connected") await edit(state => { const current = state.accounts.find(record => record.value.id === report.id)!.value; if (current.status === "connected") { current.status = "unbound"; current.updatedAt = Date.now(); } });
  }
  return agentPublishingAccounts(agentId);
}
/** 仅新凭据代次的独立授权失败推进恢复epoch，保留工作；重复进度、旧凭据和旧OAuth不能重新锁号或解锁。 */
export async function requirePublishingReauthorization(agentId: string, accountId: string, failure?: { jobId: string; id?: string; generation?: string }) {
  return edit(state => {
    const record = state.accounts.find(value => value.value.id === accountId && value.value.agentId === agentId);
    if (!record) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
    const account = record.value;
    if (["cleanup_pending", "deleted"].includes(account.status)) return false;
    // OAuth成功后的凭据代次只由Cloud一次性事务推进；旧任务、旧Agent和进度sequence不能伪装新凭据失败。
    if (record.authorizationGeneration && failure?.generation !== record.authorizationGeneration) return false;
    if (failure?.id && record.authorizationFailures?.[failure.jobId] === failure.id) return false;
    if (failure?.id) (record.authorizationFailures ??= {})[failure.jobId] = failure.id;
    record.reauthorizationEpoch = randomUUID(); account.status = "needs_reauthorization"; account.updatedAt = Date.now();
    return true;
  });
}
/** 新浏览器事务推进服务端epoch；需要切换受保护凭据时先暂停新业务，不依据Agent时钟判断先后。 */
export async function publishingReauthorizationEpoch(agentId: string, accountId: string, protectGeneration = false, begin = false, generation?: string) {
  return edit(state => {
    const record = state.accounts.find(value => value.value.id === accountId && value.value.agentId === agentId);
    if (!record) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
    if (["cleanup_pending", "deleted"].includes(record.value.status)) throw new AppError("CLEANUP", "此账号正在清理，不能重新授权。", 409);
    if (begin) {
      const previous = protectGeneration && record.value.status === "connected" && record.value.channelId && !record.authorizationAttempt ? { generation: record.authorizationGeneration, channelId: record.value.channelId, connectedAt: record.value.connectedAt } : undefined;
      record.reauthorizationEpoch = randomUUID(); record.authorizationAttempt = { epoch: record.reauthorizationEpoch, generation, writePossible: false, ...(previous ? { previous } : {}) };
    } else record.reauthorizationEpoch ??= randomUUID();
    // 切换新凭据到最终确认之间关闭普通业务；原OAuth任务仍可执行token/channels例外。
    if (protectGeneration && record.value.status === "connected") { record.value.status = "needs_reauthorization"; record.value.updatedAt = Date.now(); }
    return record.reauthorizationEpoch;
  });
}
/** 只有原健康状态、相同事务且Token写入屏障尚未通过的明确取消可恢复；新401、后继授权和未知写入均保持保护。 */
export async function cancelPublishingReauthorization(agentId: string, accountId: string, epoch?: string, generation?: string) {
  return edit(state => {
    const record = state.accounts.find(value => value.value.id === accountId && value.value.agentId === agentId); const attempt = record?.authorizationAttempt;
    if (!record || !attempt || !epoch || record.reauthorizationEpoch !== epoch || attempt.epoch !== epoch || attempt.generation !== generation) return false;
    const previous = attempt.previous;
    const restore = record.value.status === "needs_reauthorization" && !!previous && !attempt.writePossible && record.authorizationGeneration === previous.generation && record.value.channelId === previous.channelId && record.value.connectedAt === previous.connectedAt;
    if (restore) { record.value.status = "connected"; record.value.updatedAt = Date.now(); }
    delete record.authorizationAttempt; record.reauthorizationEpoch = randomUUID(); return restore;
  });
}
/** 原OAuth任务只属于开始时的服务端事务；新事务或新401到达后，旧任务不能再交换/保存凭据。 */
export async function assertPublishingAuthorizationEpoch(agentId: string, accountId: string, epoch: string) {
  const record = (await readState()).accounts.find(value => value.value.id === accountId && value.value.agentId === agentId);
  if (!record || ["cleanup_pending", "deleted"].includes(record.value.status) || record.reauthorizationEpoch !== epoch) throw new AppError("OAUTH_SUPERSEDED", "此授权已被更新的连接或授权错误替代，请重新连接原频道。", 409);
}
/** 仅原浏览器的当前OAuth可提交凭据代次；令牌末尾写入或Cloud确认失败保持needs，允许重新授权恢复部分提交。 */
export async function completePublishingReauthorization(agentId: string, accountId: string, epoch?: string, generation?: string) {
  return edit(state => {
    const record = state.accounts.find(value => value.value.id === accountId && value.value.agentId === agentId);
    if (!record) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
    if (["cleanup_pending", "deleted"].includes(record.value.status) || !epoch || record.reauthorizationEpoch !== epoch) return false;
    record.value.status = "connected"; record.value.connectedAt = Date.now(); record.value.updatedAt = Date.now(); record.reauthorizationEpoch = randomUUID();
    delete record.authorizationAttempt;
    if (generation) { record.authorizationGeneration = generation; record.authorizationFailures = {}; }
    return true;
  });
}
/** 清理意图与账号停用原子持久化；离线也保留七日截止时间，绝不声称本机已删除。 */
export async function beginPublishingAccountCleanup(agentId: string, accountId: string, actor: string) {
  return edit(async state => {
    const record = state.accounts.find(record => record.value.id === accountId && record.value.agentId === agentId); if (!record) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
    const existing = state.cleanups.find(cleanup => cleanup.accountId === accountId); if (existing) return existing;
    const account = record.value; const cleanup: PublishingAccountCleanup = { id: randomUUID(), accountId, agentId, instanceId: account.instanceId, owner: account.owner, actor, createdAt: Date.now(), deadline: Date.now() + 7 * 86400_000, state: "pending" };
    account.status = "cleanup_pending"; account.updatedAt = Date.now(); state.cleanups.push(cleanup); return cleanup;
  });
}
/** Browser 删除入口允许重复核对已经停用的同一账号，但仍检查当前归属。 */
export async function requestPublishingAccountCleanup(user: Member, accountId: string) {
  const account = (await readState()).accounts.find(record => record.value.id === accountId)?.value;
  if (!account) throw new AppError("ACCOUNT", "发布账号不存在。", 404);
  const agent = await authorizeAgent(user, account.agentId); await requireTarget(account.agentId, account.instanceId);
  if (agent.owner && agent.owner !== account.owner || user.role !== "admin" && account.owner !== user.username) throw new AppError("FORBIDDEN", "不能删除其他客户的发布账号。", 403);
  return beginPublishingAccountCleanup(account.agentId, accountId, user.username);
}
/** 重连先提供账号级清理任务，仅携带 ID 与宿主路由，不携带凭据。 */
export async function publishingAccountCleanups(agentId?: string) { return (await readState()).cleanups.filter(cleanup => !agentId || cleanup.agentId === agentId); }
/** 只有所属 Agent 确认本机清理与撤销后才释放独立频道；直播绑定和状态完全不在此事务范围。 */
export async function completePublishingAccountCleanup(agentId: string, id: string) {
  return edit(state => {
    const cleanup = state.cleanups.find(cleanup => cleanup.id === id && cleanup.agentId === agentId); if (!cleanup) throw new AppError("CLEANUP", "独立发布账号清理请求不存在。", 404);
    const record = state.accounts.find(record => record.value.id === cleanup.accountId)!; const account = record.value;
    cleanup.state = "complete"; cleanup.completedAt ??= Date.now(); account.status = "deleted"; account.deletedAt ??= Date.now(); account.updatedAt = Date.now();
    delete account.channelId; delete account.channel; delete account.channelCheckedAt; delete account.connectedAt; delete record.candidateChannelId; delete record.candidateChannel; delete record.candidateCheckedAt; delete record.claimedAt;
    return { ok: true };
  });
}
