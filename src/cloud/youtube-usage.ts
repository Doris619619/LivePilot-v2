/** 全项目 YouTube 准入与熔断：方法成本由 Cloud 计算，Agent 只保留令牌及实际调用。 */
import { randomUUID } from "node:crypto";
import { unseal } from "@/core/storage";
import { AppError } from "@/core/errors";
import { quotaDay } from "@/core/publishing/schedule";
import { defaultPolicy } from "@/shared/publishing";
import { youtubeCost, youtubeAdmitSchema, youtubeResultSchema, youtubePolicyUpdateSchema, YOUTUBE_COST_VERSION, type YouTubeAdmit, type YouTubeResult, type YouTubePolicyUpdate, type YouTubeUsageSummary } from "@/shared/youtube-usage";
import { agentStore, listAgents, requireTarget } from "./agents";
import { requirePublishingAccount } from "./publishing-accounts";
import type { TaskRecord } from "./tasks";
import type { TaskPayload } from "@/shared/remote";
import { editYouTubeUsage, readYouTubeUsage, youtubeDay, youtubeAdmission, youtubeProject, youtubeReserved, findYouTubeReceipts, saveArchivedYouTubeResults, youtubeHotCapacity, type YouTubeDay } from "./youtube-usage-store";
import { youtubeEventSummary } from "./youtube-usage-events";
/** 控制预留仅授予已经下发且匹配当前设备、实例的控制任务。 */
async function assertYouTubeContext(agentId: string, input: YouTubeAdmit) {
  const machine = await requireTarget(agentId, input.instanceId);
  if (input.accountId) await requirePublishingAccount(agentId, input.instanceId, input.accountId);
  if (input.purpose === "control") {
    const queue = await agentStore(agentId).read<{ records: TaskRecord[] }>("tasks.json");
    const task = queue?.records.find(t => t.id === input.operationId && t.instanceId === input.instanceId && t.kind === "control" && ["accepted", "running", "delivering", "uncertain"].includes(t.status));
    const methods = ["channels.list", "liveBroadcasts.list", "liveBroadcasts.insert", "liveBroadcasts.update", "liveBroadcasts.bind", "liveBroadcasts.transition", "liveStreams.list", "liveStreams.insert", "playlists.list", "playlistItems.list", "playlistItems.insert", "thumbnails.set"];
    if (!task || !methods.includes(input.method)) throw new AppError("FORBIDDEN", "控制配额必须对应当前设备的有效控制任务。", 403);
    const payload = unseal<TaskPayload>(task.payload); if (payload.kind !== "control") throw new AppError("FORBIDDEN", "控制任务不匹配。", 403);
    if (payload.input.action !== "start" && !["channels.list", "liveBroadcasts.list", "liveBroadcasts.transition", "liveStreams.list"].includes(input.method)) throw new AppError("FORBIDDEN", "结束与恢复任务不能占用创建或元数据配额。", 403);
  }
  if (input.jobId) {
    const { publishingStore } = await import("./publishing");
    const jobs = await publishingStore().read<{ jobs: { spec: { id: string; owner: string; profile: { agentId: string; instanceId: string; accountId?: string } } }[] }>("state.json");
    const job = jobs?.jobs.find(j => j.spec.id === input.jobId);
    if (!job || job.spec.profile.agentId !== agentId || job.spec.profile.instanceId !== input.instanceId || job.spec.profile.accountId !== input.accountId || machine.owner && machine.owner !== job.spec.owner) throw new AppError("FORBIDDEN", "发布调用不属于当前设备或账号。", 403);
  }
  if (input.method === "liveChatMessages.insert" && input.purpose !== "chat-send" || input.method === "liveChatMessages.streamList" && input.purpose !== "chat-stream") throw new AppError("FORBIDDEN", "聊天请求必须使用对应子预算。", 403);
  if (input.purpose === "publishing") { const { publishingStore } = await import("./publishing"); const state = await publishingStore().read<{ policy: { otherUnitsPerDay: number; uploadsPerDay: number } }>("state.json"); return state?.policy || defaultPolicy; }
}
/** 真实请求前 fsync 预扣；同一 attempt 的丢失响应重试不会重复扣账。 */
export async function admitYouTube(agentId: string, raw: YouTubeAdmit) {
  const input = youtubeAdmitSchema.parse(raw); const publishingPolicy = await assertYouTubeContext(agentId, input);
  const project = youtubeProject(input.clientFingerprint);
  const active = (await Promise.all((await listAgents()).filter(a => a.online && !a.revoked).map(async agent => {
    const heartbeat = await agentStore(agent.id).read<{ snapshots: { dashboard: { state: { phase: string }; obs: { streaming?: boolean | null }; youtube: { authorization?: string; connected: boolean } } }[] }>("heartbeat.json");
    return (heartbeat?.snapshots || []).filter(({ dashboard }) => (dashboard.youtube.authorization === "present" || dashboard.youtube.connected) && (dashboard.obs.streaming === true || ["starting", "live", "stopping"].includes(dashboard.state.phase))).length;
  }))).reduce((sum, count) => sum + count, 0);
  const cost = youtubeCost(input.method);
  return editYouTubeUsage(async state => {
    const day = youtubeDay(state); const result = youtubeAdmission(state, day, input, cost.units, cost.bucket, active);
    const older = (await findYouTubeReceipts(state, [input.attemptId])).get(input.attemptId)?.archiveDay;
    if (older) return { ...result, code: "YOUTUBE_ATTEMPT_EXPIRED", blockedUntil: Date.now() + 1000 };
    const previous = day.receipts[input.attemptId];
    if (previous) { if (previous.agentId !== agentId || JSON.stringify(previous.input) !== JSON.stringify(input)) throw new AppError("REQUEST", "请求标识已用于其他调用。", 409); if (previous.result) return { ...result, code: "YOUTUBE_ATTEMPT_FINISHED", blockedUntil: Date.now() + 1000 }; if ((day.breakerUntil || 0) > Date.now()) return { ...result, code: "YOUTUBE_DAILY_QUOTA", blockedUntil: day.breakerUntil }; return previous.admission; }
    /** 拒绝不写成实际上游扣账；明确恢复时间让 Agent 停止空转。 */
    const block = (code: string, until = result.resetAt) => ({ ...result, code, blockedUntil: until });
    if (!project) return block("YOUTUBE_PROJECT_UNKNOWN");
    if (youtubeHotCapacity(state, Buffer.byteLength(JSON.stringify({ agentId, input, admission: { ...result, allowed: true } })) + 1024).blocked) return block("YOUTUBE_PROTECTION_STORAGE", Date.now() + 60_000);
    if (!day.baseline.known && cost.bucket !== "none") return block("YOUTUBE_BASELINE_UNKNOWN");
    if (day.breakerUntil && day.breakerUntil > Date.now() && cost.bucket !== "none") return block("YOUTUBE_DAILY_QUOTA", day.breakerUntil);
    const other = youtubeReserved(day, input.jobId); const general = cost.bucket === "general" ? cost.units : 0;
    const ceiling = state.policy.dailyUnits - (input.purpose === "control" ? 0 : state.policy.controlReserve);
    if (cost.bucket === "general" && day.baseline.units + day.units + other.units + general > ceiling || cost.bucket === "upload" && day.baseline.uploads + day.uploads + other.uploads + 1 > state.policy.uploadsPerDay || cost.bucket === "search" && day.searches + 1 > state.policy.searchesPerDay) return block("YOUTUBE_BUDGET");
    const purposeLimit = input.purpose === "chat-send" ? state.policy.sendUnits : input.purpose === "chat-stream" ? state.policy.streamUnits : input.purpose === "background" ? state.policy.backgroundUnits : undefined;
    if (purposeLimit !== undefined && (day.purposes[input.purpose] || 0) + general > purposeLimit) return block("YOUTUBE_PURPOSE_BUDGET");
    if (publishingPolicy && ((day.purposes.publishing || 0) + other.units + general > publishingPolicy.otherUnitsPerDay || cost.bucket === "upload" && day.uploads + other.uploads + 1 > publishingPolicy.uploadsPerDay)) return block("YOUTUBE_PUBLISHING_BUDGET");
    const now = Date.now(); day.tokens = Math.min(state.policy.burstUnits, day.tokens + Math.max(0, now - day.tokenAt) * state.policy.unitsPerMinute / 60_000); day.tokenAt = now;
    if (input.purpose !== "control" && general > day.tokens) return block("YOUTUBE_RATE", now + Math.ceil((general - day.tokens) * 60_000 / state.policy.unitsPerMinute));
    if (input.purpose !== "control") day.tokens -= general;
    day.units += general; if (cost.bucket === "upload") day.uploads++; if (cost.bucket === "search") day.searches++;
    day.purposes[input.purpose] = (day.purposes[input.purpose] || 0) + general;
    const own = input.jobId && day.reservations[input.jobId]; if (own) { own.units = Math.max(0, own.units - general); own.uploads = Math.max(0, own.uploads - Number(cost.bucket === "upload")); }
    Object.assign(result, { allowed: true, remaining: Math.max(0, state.policy.dailyUnits - day.baseline.units - day.units - youtubeReserved(day).units), backgroundRemaining: Math.max(0, state.policy.backgroundUnits - (day.purposes.background || 0)) });
    day.receipts[input.attemptId] = { agentId, input, admission: result }; return result;
  });
}
/** 只接受已准入调用的结果；真实 quota 信号按项目广播到下个 PT 午夜。 */
export async function reportYouTubeResult(agentId: string, raw: YouTubeResult) {
  const input = youtubeResultSchema.parse(raw);
  return editYouTubeUsage(async state => {
    const location = (await findYouTubeReceipts(state, [input.attemptId])).get(input.attemptId); const receipt = location?.receipt;
    if (!receipt || receipt.agentId !== agentId) throw new AppError("FORBIDDEN", "调用记录不属于当前设备。", 403);
    if (receipt.result) return { ok: true as const };
    receipt.result = input;
    if (["quotaExceeded", "dailyLimitExceeded"].includes(input.errorCode || "")) { const day = youtubeDay(state); if (receipt.admission.quotaDay === day.day) day.breakerUntil = receipt.admission.resetAt; }
    if (location?.archiveDay) await saveArchivedYouTubeResults([location]); return { ok: true as const };
  });
}
/** 旧发布路由委托项目总账；未知结果仍占预算，receipt 与旧任务绑定。 */
export async function chargeLegacyYouTubePublishing(agentId: string, jobId: string, receipt: string, units: number, upload: boolean) {
  return editYouTubeUsage(state => {
    const day = youtubeDay(state); const key = agentId + ":" + receipt; const value = { units, uploads: Number(upload) };
    if (day.legacy[key]) { if (JSON.stringify(day.legacy[key]) !== JSON.stringify(value)) throw new AppError("REQUEST", "发布调用标识冲突。", 409); return { ok: true as const }; }
    if (youtubeHotCapacity(state, Buffer.byteLength(key) + 256).blocked) throw new AppError("YOUTUBE_PROTECTION_STORAGE", "项目配额账本已达到安全容量，新的YouTube调用已暂停。", 503);
    const reserved = youtubeReserved(day, jobId);
    if (!day.baseline.known || (day.breakerUntil || 0) > Date.now() || day.baseline.units + day.units + reserved.units + units > state.policy.dailyUnits - state.policy.controlReserve || day.baseline.uploads + day.uploads + reserved.uploads + Number(upload) > state.policy.uploadsPerDay) throw new AppError("VIDEO_QUOTA", "项目配额保护已暂停新的发布请求，请检查配额基线及预算。", 503);
    day.units += units; day.uploads += Number(upload); day.purposes.publishing = (day.purposes.publishing || 0) + units; day.legacy[key] = value;
    const own = day.reservations[jobId]; if (own) { own.units = Math.max(0, own.units - units); own.uploads = Math.max(0, own.uploads - Number(upload)); } return { ok: true as const };
  });
}
/** 发布派发先预留同一全项目账本；保留旧发布子预算作为更严格的局部限制。 */
export async function reserveYouTubePublishing(jobId: string, units: number, uploads: number) {
  return editYouTubeUsage(state => { const day = youtubeDay(state); if (!day.baseline.known || (day.breakerUntil || 0) > Date.now()) return false; if (day.reservations[jobId]) return true; const reserved = youtubeReserved(day);
    if (day.baseline.units + day.units + reserved.units + units > state.policy.dailyUnits - state.policy.controlReserve || day.baseline.uploads + day.uploads + reserved.uploads + uploads > state.policy.uploadsPerDay) return false;
    day.reservations[jobId] = { units, uploads }; return true;
  });
}
/** 已终态或取消的任务归还未消费预留，不退还已经可能到达 Google 的成本。 */
export async function releaseYouTubePublishing(jobIds: string[]) { return editYouTubeUsage(state => { for (const day of Object.values(state.days)) for (const id of jobIds) delete day.reservations[id]; }); }
/** 首次升级导入旧发布已用量；后续只同步旧未消费预留，重复调用不重复扣账。 */
export async function seedLegacyYouTubePublishing(input: { day: string; units: number; uploads: number; reservations?: Record<string, { units: number; uploads: number }> }) {
  if (input.day !== quotaDay()) return;
  if (!Number.isInteger(input.units) || input.units < 0 || !Number.isInteger(input.uploads) || input.uploads < 0) throw new AppError("STORAGE", "原发布配额账本无效，请保留数据并检查。");
  return editYouTubeUsage(state => {
    const day = youtubeDay(state);
    if (day.legacySeed) return;
    { day.legacySeed = { units: input.units, uploads: input.uploads }; day.units += input.units; day.uploads += input.uploads; day.purposes.publishing = (day.purposes.publishing || 0) + input.units;
      if (day.baseline.reportedUnits !== undefined) { day.baseline.units = Math.max(0, day.baseline.units - input.units); day.baseline.uploads = Math.max(0, day.baseline.uploads - input.uploads); }
    }
    const incoming = input.reservations || {};
    for (const [id, amount] of Object.entries(incoming)) { if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(amount.units) || amount.units < 0 || !Number.isInteger(amount.uploads) || amount.uploads < 0) throw new AppError("STORAGE", "原发布预留记录无效，请保留数据并检查。"); day.reservations[id] = amount; }
    day.legacyReservationIds = Object.keys(incoming);
  });
}
/** 管理员只可提供当前日历史基线；提高基线不会抹掉应用已记录的调用。 */
export async function updateYouTubePolicy(raw: YouTubePolicyUpdate, actor: string) {
  const input = youtubePolicyUpdateSchema.parse(raw);
  await editYouTubeUsage(state => { if (input.policy) state.policy = input.policy; const day = youtubeDay(state);
    if (input.baseline) { if (input.baseline.day !== quotaDay() || day.baseline.known && (input.baseline.units < (day.baseline.reportedUnits ?? day.baseline.units) || input.baseline.uploads < (day.baseline.reportedUploads ?? day.baseline.uploads))) throw new AppError("INPUT", "仅可设置当前 PT 配额日基线，已记录的历史基线不能降低。", 409); day.baseline = { known: true, ...input.baseline, reportedUnits: input.baseline.units, reportedUploads: input.baseline.uploads, units: Math.max(day.baseline.units, input.baseline.units - day.units, 0), uploads: Math.max(day.baseline.uploads, input.baseline.uploads - day.uploads, 0) }; }
  });
  const { audit } = await import("@/core/audit"); await audit(actor, "youtube-quota-policy", "main", "updated", randomUUID()); return youtubeUsageSummary();
}
/** 管理员汇总所有有效设备覆盖率，数据来源仅本地文件，不向 YouTube 发请求。 */
export async function youtubeUsageSummary(dayValue?: string): Promise<YouTubeUsageSummary> {
  const devices = (await listAgents()).filter(a => a.paired && !a.revoked && !a.pairedTo);
  const coverage = await Promise.all(devices.map(async a => { const capabilities = await agentStore(a.id).read<string[]>("capabilities.json") || []; return { agentId: a.id, name: a.name, online: a.online, protected: ["youtube-quota-v1", "youtube-usage-v1"].every(value => capabilities.includes(value)) }; }));
  const state = await readYouTubeUsage(); const current = youtubeDay(state); const day: YouTubeDay = state.days[dayValue || current.day] || { ...current, day: dayValue!, units: 0, uploads: 0, searches: 0, purposes: {}, receipts: {}, legacy: {}, reservations: {}, baseline: { known: false, units: 0, uploads: 0 } };
  const value = { project: "current-project", day: day.day, costVersion: YOUTUBE_COST_VERSION, policy: state.policy, baseline: day.baseline, usedUnits: day.units, uploads: day.uploads, searches: day.searches, reservedUnits: youtubeReserved(day).units, remainingUnits: Math.max(0, state.policy.dailyUnits - day.baseline.units - day.units - youtubeReserved(day).units), breakerUntil: day.breakerUntil, byPurpose: day.purposes, storage: youtubeHotCapacity(state), resetAt: youtubeAdmission(state, current, { attemptId: "", clientFingerprint: "", instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard" }, 1, "general", 1).resetAt };
  return { ...value, coverage: { protected: coverage.filter(a => a.protected).length, total: coverage.length, devices: coverage }, ...await youtubeEventSummary(value.day) };
}
