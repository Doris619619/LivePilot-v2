/** 所有 Google 出站请求的统一准入与脱敏计量；未安装 Cloud 运行时一律禁止联网。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { YouTubeAdmit, YouTubeAdmission, YouTubeMethod, YouTubeResult, YouTubeUsageEvent } from "@/shared/youtube-usage";
import { youtubeBlockReasonSchema, type YouTubeBlockReason } from "@/shared/youtube-usage";
import { AppError, isAppError } from "../errors";
import { nextQuotaMidnight } from "../live-chat/policy";
import { makeProblem } from "@/shared/problems";

export type YouTubeContext = Pick<YouTubeAdmit, "instanceId" | "accountId" | "jobId" | "operationId" | "purpose" | "trigger" | "retryCount">;
export type YouTubeAttempt = Omit<YouTubeAdmit, "clientFingerprint">;
export type YouTubeRuntimeEvent = Omit<YouTubeUsageEvent, "eventId" | "bootId" | "sequence">;
export interface YouTubeRuntime {
  admit(attempt: YouTubeAttempt): Promise<YouTubeAdmission>;
  record(event: YouTubeRuntimeEvent): Promise<void>;
  canSend?(admission: YouTubeAdmission): boolean;
}
const protectionMessages: Partial<Record<YouTubeBlockReason, string>> = {
  YOUTUBE_DAILY_QUOTA: "Google 已确认本项目每日配额耗尽，等待太平洋时间次日午夜恢复。",
  YOUTUBE_BASELINE_UNKNOWN: "当前配额日的历史消耗尚未确认，请管理员录入用量基线或等待下一配额日。",
  YOUTUBE_BUDGET: "本应用今日请求预算已用尽，请等待恢复或联系管理员调整预算。",
  YOUTUBE_PURPOSE_BUDGET: "此功能今日请求预算已用尽，请等待恢复或联系管理员调整子预算。",
  YOUTUBE_PUBLISHING_BUDGET: "普通视频发布预算已用尽，请等待恢复或联系管理员核对发布预算。",
  YOUTUBE_RATE: "自动化请求触发项目短时限流，将在恢复时间重新核对准入。",
  YOUTUBE_PROJECT_UNKNOWN: "Google 应用尚未映射到受保护项目，请管理员核对应用配置。",
  YOUTUBE_PROJECT_UNMAPPED: "Google 应用尚未映射到受保护项目，请管理员核对应用配置。",
  YOUTUBE_PROTECTION_OFFLINE: "直播电脑暂未连接支持配额保护的控制端，新的 YouTube 请求暂停；已有 OBS 推流继续。",
  YOUTUBE_PROTECTION_STORAGE: "配额保护记录暂不可用，新的 YouTube 请求暂停，请管理员检查存储。",
  YOUTUBE_ATTEMPT_EXPIRED: "本次请求准入已过期，尚未发送新的 YouTube 请求；请重新核对原操作。",
  YOUTUBE_ATTEMPT_FINISHED: "本次请求准入已使用完成，禁止重复发送同一请求。",
};
export class YouTubeProtectionError extends AppError {
  /** 固定公开阻断原因及恢复时间；不将 Cloud 或 Google 原始错误传给用户。 */
  constructor(code: string, readonly retryAt: number, readonly blockReason?: YouTubeBlockReason) {
    const reason = blockReason || youtubeBlockReasonSchema.safeParse(code).data;
    const message = (reason && protectionMessages[reason]) || "YouTube 请求已由配额保护暂停，请等待恢复或联系管理员核对预算。";
    super(code, message, 429, makeProblem(code, message, { domain: "youtube", outcome: "not-sent", context: { retryAt } }));
  }
}
const scope = new AsyncLocalStorage<Partial<YouTubeContext>>();
let runtime: YouTubeRuntime | undefined;
let breakerUntil = 0;
let latestAdmission: YouTubeAdmission | undefined;

/** 宿主安装已认证的 Cloud 准入及本地日志通道；卸载后新的出站请求立即拒绝。 */
export function installYouTubeRuntime(value?: YouTubeRuntime) { runtime = value; latestAdmission = undefined; breakerUntil = 0; }
/** 业务操作携带来源和关联 ID；子调用继承范围，不能把凭据或正文放入上下文。 */
export function withYouTubeContext<T>(context: Partial<YouTubeContext>, action: () => T): T { return scope.run({ ...scope.getStore(), ...context }, action); }
/** 按当前项目剩余巡检预算分配下次检查，健康平台状态至少缓存五分钟。 */
export function youtubeBackgroundInterval(): number {
  const admission = latestAdmission;
  if (!admission) return 300_000;
  const remaining = Math.max(1, admission.backgroundRemaining);
  return Math.max(300_000, Math.ceil(Math.max(0, admission.resetAt - Date.now()) * Math.max(1, admission.activeInstances) * 2 / remaining));
}
/** 日志不可用不阻塞 OBS、心跳或已获准的请求；宿主必须记录缓存缺口。 */
async function record(target: YouTubeRuntime, event: YouTubeRuntimeEvent) { try { await target.record(event); } catch { /* 预算已由准入事务持久化，明细失败交由宿主报告缺口。 */ } }
/** 将来源与实例身份合并为严格白名单上下文；业务操作范围优先于 API 默认用途。 */
function context(defaults: YouTubeContext): YouTubeContext { return { ...defaults, ...scope.getStore() }; }
/** 缓存命中单独记录决定，永远不增加真实上游尝试或预扣。 */
export function recordYouTubeCache(method: YouTubeMethod, defaults: YouTubeContext) {
  if (runtime) void record(runtime, { ...context(defaults), method, transport: "rest", kind: "decision", decision: "cache", at: Date.now() });
}
export type YouTubeCall = { assertReady(): void; finish(result: Omit<YouTubeResult, "attemptId" | "durationMs">): Promise<void> };
/** 每个真实请求先持久预扣；一个 handle 只完成一次，连接批次不重复计费。 */
export async function admitYouTubeCall(method: YouTubeMethod, defaults: YouTubeContext): Promise<YouTubeCall> {
  const target = runtime;
  if (!target) throw new YouTubeProtectionError("YOUTUBE_PROTECTION_OFFLINE", Date.now() + 30_000);
  const current = context(defaults); const attemptId = randomUUID();
  current.retryCount ??= 0;
  // 聊天流可能由控制配置异步唤醒，继承的控制范围不能让自动回复使用控制预留。
  if (method === "liveChatMessages.streamList") { current.purpose = "chat-stream"; current.trigger = "chat-connect"; }
  if (method === "liveChatMessages.insert") { current.purpose = "chat-send"; current.trigger = "chat-send"; }
  // 过期 token 刷新是授权网络事件，即使由开停播唤起，也不能伪装成控制方法。
  if (method.startsWith("oauth.")) current.purpose = "authorization";
  const transport = method.startsWith("oauth.") ? "oauth" : method === "liveChatMessages.streamList" ? "grpc" : method.startsWith("videos.upload.") || method === "videos.insert" ? "upload" : "rest";
  const base = { ...current, method, transport, attemptId } as const;
  if (breakerUntil > Date.now() && !method.startsWith("oauth.")) {
    await record(target, { ...base, at: Date.now(), kind: "decision", decision: "blocked", blockReason: "YOUTUBE_DAILY_QUOTA", retryDelayMs: Math.min(86400_000, breakerUntil - Date.now()) });
    throw new YouTubeProtectionError("YOUTUBE_DAILY_QUOTA", breakerUntil);
  }
  const admission = await target.admit({ ...current, method, attemptId });
  if (admission.allowed) latestAdmission = admission;
  if (!admission.allowed) {
    // 管理员可以补基线或调整应用预算；这些拒绝每分钟仅重核 Cloud，不等待到午夜。
    const providerQuota = admission.code === "YOUTUBE_DAILY_QUOTA";
    const retryAt = providerQuota ? admission.blockedUntil || nextQuotaMidnight(Date.now()) : Math.min(admission.blockedUntil || Date.now() + 30_000, Date.now() + 60_000);
    const blockReason = youtubeBlockReasonSchema.safeParse(admission.code).data;
    await record(target, { ...base, at: Date.now(), kind: "decision", decision: "blocked", ...(blockReason ? { blockReason } : {}), retryDelayMs: Math.min(86400_000, Math.max(0, retryAt - Date.now())) });
    throw new YouTubeProtectionError(providerQuota ? "YOUTUBE_DAILY_QUOTA" : "YOUTUBE_PROTECTION_WAIT", retryAt, blockReason);
  }
  const started = Date.now(); const monotonic = performance.now(); await record(target, { ...base, at: started, kind: "start" }); let finished = false;
  return { assertReady() {
    if (runtime !== target || target.canSend?.(admission) === false) throw new YouTubeProtectionError("YOUTUBE_PROTECTION_OFFLINE", Date.now() + 30_000);
  }, async finish(result) {
    if (finished) return; finished = true;
    if (result.errorCode === "quotaExceeded" || result.errorCode === "dailyLimitExceeded") breakerUntil = nextQuotaMidnight(Date.now());
    await record(target, { ...base, at: Date.now(), kind: "finish", durationMs: Math.min(7 * 86400_000, Math.max(0, Math.floor(performance.now() - monotonic))), ...result });
  } };
}
/** 安全分类 HTTP 结果；只读取白名单 reason，绝不持久化响应正文或请求地址。 */
export async function youtubeFetch(method: YouTubeMethod, defaults: YouTubeContext, request: () => Promise<Response>): Promise<Response> {
  const call = await admitYouTubeCall(method, defaults);
  try {
    call.assertReady();
    const response = await request(); let errorCode: YouTubeResult["errorCode"];
    if (!response.ok && response.status !== 308) {
      const data = await response.clone().json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null;
      const reasons = data?.error?.errors?.map(item => item.reason) || [];
      errorCode = reasons.includes("quotaExceeded") ? "quotaExceeded" : reasons.includes("dailyLimitExceeded") ? "dailyLimitExceeded" : response.status === 429 || reasons.includes("rateLimitExceeded") ? "rateLimitExceeded" : response.status === 401 ? "auth" : "rejected";
    }
    await call.finish({ outcome: response.ok || response.status === 308 ? "succeeded" : response.status >= 500 ? "unknown" : "failed", httpStatus: response.status, ...(errorCode ? { errorCode } : {}) });
    return response;
  } catch (error) {
    await call.finish({ outcome: error instanceof YouTubeProtectionError ? "cancelled" : "unknown", errorCode: error instanceof YouTubeProtectionError ? "cancelled" : "network" });
    if (isAppError(error)) throw error;
    throw new AppError("YOUTUBE_NETWORK", "YouTube 网络请求中断，结果尚未确认。", 502);
  }
}

/** 所有分页共用页数、期限与重复游标检查；越界表示未知结果，不能当成未找到。 */
export class YouTubePageGuard {
  private readonly deadline = Date.now() + 30_000;
  private readonly visited = new Set<string>();
  readonly signal = AbortSignal.timeout(30_000);
  /** 响应完成也检查期限，避免忽略 AbortSignal 的模拟或适配器把迟到结果当成完整核对。 */
  check() { if (Date.now() >= this.deadline) throw new AppError("RECOVER", "YouTube 分页核对已超时，结果尚未确认；请到 Studio 核对。", 409); }
  /** 在每页出站前检查；初始空游标也占一页，最多允许二十页。 */
  next(token: string) {
    if (this.visited.size >= 20 || Date.now() >= this.deadline || this.visited.has(token)) throw new AppError("RECOVER", "YouTube 分页核对达到安全上限，结果尚未确认；请到 Studio 核对后再操作。", 409);
    this.visited.add(token);
  }
}
