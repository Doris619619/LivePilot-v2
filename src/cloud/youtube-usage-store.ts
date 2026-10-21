/** YouTube 持久配额账本：独立 fsync 原子文件及跨进程短事务。 */
import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { PublishingStore } from "@/core/publishing/storage";
import { quotaDay } from "@/core/publishing/schedule";
import { nextQuotaMidnight } from "@/core/live-chat/policy";
import { config } from "@/core/config";
import { AppError } from "@/core/errors";
import { defaultYouTubePolicy, youtubePolicySchema, youtubeAdmitSchema, youtubeResultSchema, type YouTubeAdmit, type YouTubeAdmission, type YouTubePolicy, type YouTubeResult } from "@/shared/youtube-usage";
import { cloudStore, transaction } from "./store";
export type Receipt = { agentId: string; input: YouTubeAdmit; admission: YouTubeAdmission; result?: YouTubeResult };
export type YouTubeDay = { day: string; baseline: { known: boolean; units: number; uploads: number; source?: string; reportedUnits?: number; reportedUploads?: number }; units: number; uploads: number; searches: number; purposes: Record<string, number>; breakerUntil?: number; tokens: number; tokenAt: number; receipts: Record<string, Receipt>; legacy: Record<string, { units: number; uploads: number }>; reservations: Record<string, { units: number; uploads: number }>; legacySeed?: { units: number; uploads: number }; legacyReservationIds?: string[] };
export type YouTubeState = { createdAt: number; initialDay: string; policy: YouTubePolicy; policyRevision: number; days: Record<string, YouTubeDay> };
export const YOUTUBE_HOT_LIMIT = 32 * 1024 ** 2;
export type YouTubeReceiptLocation = { receipt: Receipt; archiveDay?: string };
type ReceiptArchive = { day: string; receipts: Record<string, Receipt>; legacy: Record<string, { units: number; uploads: number }> };
const archivedIds = new Map<string, Set<string>>();
const archiveCleanupDay = new Map<string, string>();
/** 完整验证PT日期，拒绝仅满足正则却并不存在的配额日。 */
function validDay(value: string) { try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; } }
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDay);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reservationSchema = z.object({ units: amount, uploads: amount }).strict();
const admissionSchema = z.object({ allowed: z.boolean(), attemptId: z.string().uuid(), project: z.literal("current-project"), quotaDay: dateSchema, units: amount, bucket: z.enum(["general", "upload", "search", "none"]), remaining: amount, backgroundRemaining: amount, activeInstances: z.number().int().min(1), resetAt: amount, blockedUntil: amount.optional(), code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional() }).strict();
const receiptSchema = z.object({ agentId: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), input: youtubeAdmitSchema, admission: admissionSchema, result: youtubeResultSchema.optional() }).strict();
const daySchema = z.object({ day: dateSchema, baseline: z.object({ known: z.boolean(), units: amount, uploads: amount, source: z.enum(["google-console", "conservative-estimate", "observed-reset"]).optional(), reportedUnits: amount.optional(), reportedUploads: amount.optional(), day: dateSchema.optional() }).strict(), units: amount, uploads: amount, searches: amount.default(0), purposes: z.record(z.string(), amount), breakerUntil: amount.optional(), tokens: z.number().nonnegative().max(10000), tokenAt: amount, receipts: z.record(z.string().uuid(), receiptSchema), legacy: z.record(z.string(), reservationSchema), reservations: z.record(z.string().uuid(), reservationSchema), legacySeed: reservationSchema.optional(), legacyReservationIds: z.array(z.string().uuid()).optional() }).strict();
const stateSchema = z.object({ createdAt: amount, initialDay: dateSchema, policy: youtubePolicySchema, policyRevision: amount.default(0), days: z.record(dateSchema, daySchema) }).strict();
const archiveSchema = z.object({ day: dateSchema, receipts: z.record(z.string().uuid(), receiptSchema), legacy: z.record(z.string(), reservationSchema) }).strict();
/** 有效JSON也须验证数值及归属；NaN式比较或错误字段绝不能使预算意外放行。 */
function validateYouTubeState(value: unknown): YouTubeState {
  const parsed = stateSchema.safeParse(value); if (!parsed.success) throw new AppError("STORAGE", "YouTube 配额账本格式无效，请保留原数据并检查，新的上游请求已暂停。");
  for (const [day, state] of Object.entries(parsed.data.days)) {
    if (state.day !== day || Object.entries(state.receipts).some(([id, receipt]) => receipt.input.attemptId !== id || receipt.admission.attemptId !== id || receipt.admission.quotaDay !== day)) throw new AppError("STORAGE", "YouTube 配额账本归属不一致，请保留原数据并检查。");
  }
  return parsed.data;
}
/** 独立目录复用已具 fsync 保证的原子写实现，不混写发布或旧授权文件。 */
export function youtubeUsageStore() { return new PublishingStore(path.join(cloudStore().dir, "youtube-usage")); }
/** 归档路径只由已校验PT日期构造，不能接受设备提供的任意文件名。 */
function archiveName(day: string) { if (!validDay(day)) throw new AppError("STORAGE", "配额归档日期无效。"); return "receipts-" + day + ".json"; }
/** 读取归档也验证数值和归属，损坏数据不能被当作没有历史调用。 */
async function readArchive(day: string): Promise<ReceiptArchive | null> {
  const raw = await youtubeUsageStore().read<unknown>(archiveName(day)); if (raw === null) return null;
  const parsed = archiveSchema.safeParse(raw); if (!parsed.success || parsed.data.day !== day) throw new AppError("STORAGE", "YouTube 配额归档无效，请保留原数据并检查。");
  for (const [id, receipt] of Object.entries(parsed.data.receipts)) if (receipt.input.attemptId !== id || receipt.admission.attemptId !== id || receipt.admission.quotaDay !== day) throw new AppError("STORAGE", "YouTube 配额归档归属不一致。");
  return parsed.data;
}
/** 日切先fsync完整旧日归档，再清空热明细；中途崩溃重试时保留已更新的归档结果。 */
async function archiveOldDays(state: YouTubeState, now: number) {
  const store = youtubeUsageStore(); const today = quotaDay(now); const cutoff = quotaDay(now - 14 * 86400_000);
  for (const day of Object.values(state.days)) if (day.day < today && (Object.keys(day.receipts).length || Object.keys(day.legacy).length)) {
    if (day.day >= cutoff) { const old = await readArchive(day.day); const archive: ReceiptArchive = { day: day.day, receipts: { ...day.receipts, ...old?.receipts }, legacy: { ...day.legacy, ...old?.legacy } }; await store.write(archiveName(day.day), archive); archivedIds.set(path.join(store.dir, day.day), new Set(Object.keys(archive.receipts))); }
    day.receipts = {}; day.legacy = {}; day.reservations = {};
  }
  if (archiveCleanupDay.get(store.dir) !== today) { for (const entry of await readdir(store.dir, { withFileTypes: true })) if (entry.isFile() && /^receipts-\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) { const day = entry.name.slice(9, 19); if (day < cutoff) await unlink(path.join(store.dir, entry.name)); } for (const key of archivedIds.keys()) if (path.dirname(key) === store.dir && path.basename(key) < cutoff) archivedIds.delete(key); archiveCleanupDay.set(store.dir, today); }
}
/** 批量查找当前及14天归档；归档ID集只读缓存，未命中的新请求不会反复解析旧日大文件。 */
export async function findYouTubeReceipts(state: YouTubeState, ids: string[]): Promise<Map<string, YouTubeReceiptLocation>> {
  const result = new Map<string, YouTubeReceiptLocation>(); const wanted = new Set(ids); const store = youtubeUsageStore();
  for (const day of Object.values(state.days)) for (const id of wanted) if (day.receipts[id]) { result.set(id, { receipt: day.receipts[id] }); wanted.delete(id); }
  const cutoff = quotaDay(Date.now() - 14 * 86400_000);
  for (const day of Object.keys(state.days).filter(day => day >= cutoff && day < quotaDay()).sort().reverse()) {
    if (!wanted.size) break; const key = path.join(store.dir, day); let known = archivedIds.get(key); let archive: ReceiptArchive | null = null;
    if (!known) { archive = await readArchive(day); if (!archive) continue; known = new Set(Object.keys(archive.receipts)); archivedIds.set(key, known); }
    if (![...wanted].some(id => known!.has(id))) continue;
    archive ||= await readArchive(day); if (!archive) throw new AppError("STORAGE", "YouTube 配额归档缺失，请保留数据并检查。");
    for (const id of wanted) if (archive.receipts[id]) { result.set(id, { receipt: archive.receipts[id], archiveDay: day }); wanted.delete(id); }
  }
  return result;
}
/** 在预算锁内按日合并迟到结果，每个命中归档最多一次读写，不重新导入日总额。 */
export async function saveArchivedYouTubeResults(locations: Iterable<YouTubeReceiptLocation>) {
  const grouped = new Map<string, Receipt[]>(); for (const location of locations) if (location.archiveDay) { const list = grouped.get(location.archiveDay) || []; list.push(location.receipt); grouped.set(location.archiveDay, list); }
  for (const [day, receipts] of grouped) { const archive = await readArchive(day); if (!archive) throw new AppError("STORAGE", "YouTube 配额归档缺失。"); for (const receipt of receipts) archive.receipts[receipt.input.attemptId] = receipt; await youtubeUsageStore().write(archiveName(day), archive); }
}
/** 容量包括尚未结束请求的结果预留；触顶时保留当天幂等记录，拒绝新增调用。 */
export function youtubeHotCapacity(state: YouTubeState, candidateBytes = 0) {
  const persistedBytes = Buffer.byteLength(JSON.stringify(state)); const pending = Object.values(state.days).reduce((sum, day) => sum + Object.values(day.receipts).filter(receipt => !receipt.result).length, 0); const bytes = persistedBytes + pending * 512;
  return { bytes, persistedBytes, limit: YOUTUBE_HOT_LIMIT, blocked: bytes + candidateBytes > YOUTUBE_HOT_LIMIT };
}
/** 只有首次安装日需要补历史基线；后续 PT 配额日从零计量。 */
export function youtubeDay(state: YouTubeState, now = Date.now()): YouTubeDay {
  const day = quotaDay(now);
  return state.days[day] ||= { day, baseline: { known: day !== state.initialDay, units: 0, uploads: 0, ...(day !== state.initialDay ? { source: "observed-reset" } : {}) }, units: 0, uploads: 0, searches: 0, purposes: {}, tokens: state.policy.burstUnits, tokenAt: now, receipts: {}, legacy: {}, reservations: {} };
}
/** 每次 mutation 在锁内读最新文件，避免多个设备争用剩余额度时超扣。 */
export async function editYouTubeUsage<T>(fn: (state: YouTubeState) => Promise<T> | T): Promise<T> {
  const store = youtubeUsageStore();
  return transaction(store, async () => {
    const now = Date.now(); const saved = await store.read<unknown>("budget.json"); const state = saved === null ? { createdAt: now, initialDay: quotaDay(now), policy: { ...defaultYouTubePolicy }, policyRevision: 0, days: {} } : validateYouTubeState(saved);
    await archiveOldDays(state, now); const result = await fn(state);
    const cutoff = quotaDay(now - 90 * 86400_000); const receiptCutoff = quotaDay(now - 14 * 86400_000); for (const day of Object.keys(state.days)) { if (day < cutoff) delete state.days[day]; else if (day < receiptCutoff) { state.days[day].receipts = {}; state.days[day].legacy = {}; state.days[day].reservations = {}; } }
    await store.write("budget.json", state); return result;
  }, "youtube-budget.lock");
}
/** 查看已存在的当前配额日不写盘；只在首次初始化或PT日切时持久化新日。 */
export async function readYouTubeUsage(): Promise<YouTubeState> {
  const saved = await youtubeUsageStore().read<unknown>("budget.json");
  if (saved !== null) { const state = validateYouTubeState(saved); if (state.days[quotaDay()] && !Object.values(state.days).some(day => day.day < quotaDay() && (Object.keys(day.receipts).length || Object.keys(day.legacy).length))) return state; }
  return editYouTubeUsage(state => { youtubeDay(state); return structuredClone(state); });
}
/** 真实项目由服务端固定映射；client 指纹用于匹配，不用于制造独立额度。 */
export function youtubeProject(fingerprint: string): string | undefined {
  const client = config().clientId;
  if (client && createHash("sha256").update(client).digest("hex") === fingerprint) return "current-project";
  const configured = process.env.LIVEPILOT_YOUTUBE_CLIENT_PROJECTS;
  if (!configured) return;
  try { const map = JSON.parse(configured) as Record<string, unknown>; if (map[fingerprint] === "current-project") return "current-project"; } catch { /* 无效映射关闭准入，绝不记录原配置。 */ }
}
/** 预留计入可用余额；实际请求可排除自身任务预留，避免重复计算。 */
export function youtubeReserved(day: YouTubeDay, excluding?: string) {
  return Object.entries(day.reservations).filter(([id]) => id !== excluding).reduce((sum, [, v]) => ({ units: sum.units + v.units, uploads: sum.uploads + v.uploads }), { units: 0, uploads: 0 });
}
/** 准入响应仅包含应用预算和 PT 重置点，不声称 Google 实际剩余额度。 */
export function youtubeAdmission(state: YouTubeState, day: YouTubeDay, input: YouTubeAdmit, units: number, bucket: YouTubeAdmission["bucket"], activeInstances: number): YouTubeAdmission {
  return { allowed: false, attemptId: input.attemptId, project: "current-project", quotaDay: day.day, units, bucket, remaining: Math.max(0, state.policy.dailyUnits - day.baseline.units - day.units - youtubeReserved(day).units), backgroundRemaining: Math.max(0, state.policy.backgroundUnits - (day.purposes.background || 0)), activeInstances: Math.max(1, activeInstances), resetAt: nextQuotaMidnight(Date.now()) };
}
