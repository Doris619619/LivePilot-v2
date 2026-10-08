/** 发布配置、指令和公开报告的严格协议；任何浏览器 DTO 都不含上传会话或凭据。 */
import { z } from "zod";
import { videoCopySchema, videoTagsSchema } from "./video-metadata";
export const PRIVACY_VERSION = "2026-10-01";
export const UPLOAD_NOTICE = "点击“确认上传并按计划发布”，即表示您确认上传内容符合 YouTube 服务条款（包括社区准则）。请确保不侵犯他人的版权或隐私权。";
const identity = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const safeName = z.string().min(1).max(255).refine(v => !/[\\/:%\x00-\x1f]/.test(v) && v !== "." && v !== ".." && !/[. ]$/.test(v), "素材文件名无效");
export const itemOverrideSchema = z.object({ assetId: z.string().regex(/^[a-f0-9]{64}$/), ...videoCopySchema.partial().shape, thumbnail: safeName.optional() }).strict();
export type ItemOverride = z.infer<typeof itemOverrideSchema>;
export const assetSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), filename: safeName, size: z.number().int().positive().max(256 * 1024 ** 3), mtimeMs: z.number().nonnegative(), version: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), hashState: z.enum(["not_computed", "verified"]).optional(), thumbnail: safeName.optional() }).strict();
export type MediaAsset = z.infer<typeof assetSchema>;
/** 发布包的轻量快照；扫描允许逐包错误，任务只接受有效包。 */
export const contentPackageSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), batchName: z.string().min(1).max(255), name: z.string().min(1).max(255), version: z.string().regex(/^[a-f0-9]{64}$/), sourceVideo: assetSchema.optional(), sourceMusic: assetSchema.optional(), cover: assetSchema.optional(), title: z.string().optional(), description: z.string().optional(), validationState: z.enum(["valid", "invalid"]), issues: z.array(z.string().max(500)).max(100) }).strict();
export type ContentPackage = z.infer<typeof contentPackageSchema>;
export const packageBatchSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(255), version: z.string().regex(/^[a-f0-9]{64}$/), packages: z.array(contentPackageSchema).max(10000), issues: z.array(z.string().max(500)).default([]) }).strict();
export type PackageBatch = z.infer<typeof packageBatchSchema>;
export const packagesResultSchema = z.object({ root: z.string().max(1000), batches: z.array(packageBatchSchema).max(1000), thumbnails: z.array(safeName).max(10000).optional(), channelId: z.string().optional(), channel: z.string().optional() }).strict();
/** 独立发布账号只公开设备路由和频道绑定，OAuth 凭据始终保存在 Agent。 */
export const publishingAccountSchema = z.object({ id: z.string().uuid(), agentId: identity, instanceId: identity, name: z.string().trim().min(1).max(80), owner: z.string().min(1).max(32), status: z.enum(["unbound", "connected", "cleanup_pending", "deleted"]), channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), channel: z.string().min(1).max(200).optional(), channelCheckedAt: z.number().nonnegative().optional(), createdAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(), connectedAt: z.number().nonnegative().optional(), deletedAt: z.number().nonnegative().optional() }).strict();
export type PublishingAccount = z.infer<typeof publishingAccountSchema>;
export const publishingAccountReportSchema = z.object({ id: z.string().uuid(), instanceId: identity, channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), channel: z.string().min(1).max(200).optional(), channelCheckedAt: z.number().nonnegative().optional(), connectedAt: z.number().nonnegative().optional(), cleanupPending: z.boolean().optional() }).strict();
export type PublishingAccountReport = z.infer<typeof publishingAccountReportSchema>;
/** 排期归属计划，支持同日多个时刻；旧 Profile 排期只用作初始默认值。 */
export const planRuleSchema = z.object({ timezone: z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "时区无效"), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), weeklySlots: z.array(z.object({ weekday: z.number().int().min(1).max(7), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict()).min(1).max(100), preuploadDays: z.number().int().min(1).max(365).default(28) }).strict();
export type PublishingPlanRule = z.infer<typeof planRuleSchema>;
export const planItemSchema = z.object({ packageId: z.string().regex(/^[a-f0-9]{64}$/), scheduleSource: z.enum(["auto", "manual"]).default("auto"), excluded: z.boolean().default(false), publishAt: z.string().datetime().optional(), ...videoCopySchema.partial().shape }).strict();
export type PublishingPlanItem = z.infer<typeof planItemSchema>;
/** 整批移出总览须等待当前任务的真实安全结果；用户内容与历史记录不随标记删除。 */
export type PublishingBatchRemoval = { batchId: string; requestedAt: number; completedAt?: number; name?: string };
/** 再次发布的明确确认只记录于 Cloud 计划，不修改旧视频或 Agent 上传协议。 */
export type PublishingPlan = { id: string; revision: number; owner: string; actor: string; profile: PublishingProfile; batch: PackageBatch; rule: PublishingPlanRule; items: PublishingPlanItem[]; copies: { packageId: string; title: string; description: string }[]; skippedOccupied: number; skipped: string[]; createdAt: number; confirmedAt?: number; republishJobIds?: string[]; archivedAt?: number; archivePending?: boolean; schedulePreviewId?: string; scheduleLockedPackageIds?: string[] };
/** Agent 先报告经过完整 Hash 验证的最终文件，再报告上传进度；不暴露本机路径。 */
export const preparedUploadSchema = z.object({ version: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(256 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type PreparedUpload = z.infer<typeof preparedUploadSchema>;
export const profileSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), name: z.string().min(1).max(80), agentId: identity, instanceId: identity, accountId: z.string().uuid().optional(), channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  titleTemplate: z.string().min(1).max(1000), descriptionTemplate: z.string().max(10000), tags: videoTagsSchema, categoryId: z.string().regex(/^\d{1,3}$/), playlistIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(20),
  privacy: z.enum(["public", "private", "unlisted"]), scheduled: z.boolean(), madeForKids: z.boolean(), license: z.enum(["youtube", "creativeCommon"]).default("youtube"), embeddable: z.boolean().default(true), containsSyntheticMedia: z.boolean().default(false), notifySubscribers: z.boolean().default(true),
  thumbnailMode: z.enum(["matching", "fixed", "none"]), thumbnailFilename: safeName.optional(),
  ai: z.object({ enabled: z.boolean(), language: z.string().min(1).max(40), prompt: z.string().min(1).max(4000), fallbackTitle: z.string().min(1).max(1000), fallbackDescription: z.string().max(10000) }).strict(),
  schedule: z.object({ timezone: z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "时区无效"), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), preuploadDays: z.number().int().min(1).max(365) }).strict(),
}).strict().refine(v => !v.scheduled || v.privacy === "public", "只有公开模式可定时发布").refine(v => v.thumbnailMode !== "fixed" || !!v.thumbnailFilename, "请选择固定缩略图");
export type PublishingProfile = z.infer<typeof profileSchema>;
/** 两个旧开关仅保留 wire/checkpoint 兼容并恒为 true，不表示 Google 已审核或视频已经公开。 */
export const policySchema = z.object({ enabled: z.boolean().default(true), publicVerified: z.boolean().default(true), projectKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).default("current-project"), uploadsPerDay: z.number().int().min(1).max(10000).default(20), otherUnitsPerDay: z.number().int().min(1).max(10000000).default(5000), concurrency: z.number().int().min(1).max(4).default(1), uploadMbps: z.number().min(0.1).max(10000).default(20), liveUploadMbps: z.number().min(0.1).max(10000).default(5), publishLeadSeconds: z.number().int().min(1).max(86400).default(600), chunkBytes: z.number().int().min(256 * 1024).max(32 * 1024 ** 2).multipleOf(256 * 1024).default(8 * 1024 ** 2), pollBatchSize: z.number().int().min(1).max(50).default(50), processingPollSeconds: z.number().int().min(10).max(3600).default(60), scheduledPollSeconds: z.number().int().min(10).max(86400).default(1800), tickSeconds: z.number().int().min(5).max(3600).default(60), privacyContact: z.string().max(200).default(""), verificationNote: z.string().max(2000).default("") }).strict().transform(value => ({ ...value, enabled: true, publicVerified: true }));
export type PublishingPolicy = z.infer<typeof policySchema>;
export const defaultPolicy = policySchema.parse({});
export const publishingStates = ["draft", "ready", "preparing_media", "generating_metadata", "uploading", "processing", "finalizing", "scheduled", "published", "completed", "retry_wait", "needs_attention", "paused", "cancelled", "failed"] as const;
export const desiredSchema = z.enum(["run", "pause", "cancel"]);
/** 核对只影响本次修订；可选总量供丢失检查点的只读报告匹配最终文件，不改变上传素材。 */
export const jobSpecSchema = z.object({ id: z.string().uuid(), batchId: z.string().uuid(), owner: z.string().min(1).max(32), actor: z.string().min(1).max(32), revision: z.number().int().positive(), desired: desiredSchema, reconcileRevision: z.number().int().positive().optional(), reconcileTotal: z.number().int().positive().max(256 * 1024 ** 3).optional(), asset: assetSchema, contentPackage: contentPackageSchema.refine(v => v.validationState === "valid" && !!v.sourceVideo && safeName.safeParse(v.name).success && safeName.safeParse(v.batchName).success, "发布包必须有效").optional(), plan: planRuleSchema.optional(), scheduleSource: z.enum(["auto", "manual"]).optional(), profile: profileSchema, index: z.number().int().positive(), originalPublishAt: z.string().datetime().optional(), overrides: videoCopySchema.partial().strict().default({}), policy: policySchema, consent: z.object({ version: z.literal(PRIVACY_VERSION), acceptedAt: z.number().positive(), ai: z.boolean(), temporaryPrivateTitle: z.literal(true) }).strict() }).strict().refine(v => v.consent.ai || !v.profile.ai.enabled, "AI 自动生成需要用户明确同意").refine(v => !v.profile.scheduled || !!v.originalPublishAt, "定时公开任务必须保存发布时间");
export type JobSpec = z.infer<typeof jobSpecSchema>;
export const publishingReportSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), sequence: z.number().int().positive(), state: z.enum(publishingStates), offset: z.number().int().nonnegative(), total: z.number().int().positive(), prepared: preparedUploadSchema.optional(), updatedAt: z.number().positive(), nextAttemptAt: z.number().optional(), remoteCheckedAt: z.number().optional(), authorizationInvalid: z.boolean().optional(), videoId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), effectivePublishAt: z.string().datetime().optional(), observedPrivacy: z.enum(["private", "public", "unlisted"]).optional(), processingStatus: z.string().max(40).optional(), metadata: videoCopySchema.optional(), metadataSource: z.enum(["template", "ai", "fallback", "override"]).optional(), message: z.string().max(500).optional() }).strict();
export type PublishingReport = z.infer<typeof publishingReportSchema>;
/** 预算等候由 Cloud 自动重试；可选标记兼容旧记录，不改变 Agent 上传状态机。 */
export type VideoJob = { spec: JobSpec; initialPublishAt?: string; pendingPublishAt?: string; pendingPublishAts?: string[]; hadUpload?: boolean; blockReason?: string; budgetWaiting?: true; observed?: PublishingReport; delivery?: { id: string; revision: number }; prepared?: PreparedUpload; createdAt: number };
/** 只有当前修订的真实完成事实可供用户明确再次发布；取消等待、未知上传和授权异常均不算。 */
export function canRepublishPublishingJob(job: VideoJob) {
  const report = job.observed;
  if (!report || report.revision !== job.spec.revision || report.authorizationInvalid) return false;
  if (report.state === "published") return true;
  return report.state === "completed" && (report.observedPrivacy === "public" || !job.spec.profile.scheduled && ["private", "unlisted"].includes(job.spec.profile.privacy));
}
export const assetsResultSchema = z.object({ assets: z.array(assetSchema).max(10000), thumbnails: z.array(safeName).max(10000), channelId: z.string().optional(), channel: z.string().optional() }).strict();
/** 终态任务不继续自动执行或自动重新上传。 */
export function publishingTerminal(state?: string) { return !!state && ["published", "completed", "cancelled", "failed"].includes(state); }
