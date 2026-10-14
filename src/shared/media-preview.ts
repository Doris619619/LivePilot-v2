/** 专用预览协议：仅标识、公开检查结果与有界分片，不包含路径或上传指令。 */
import { z } from "zod";
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(255).refine(v => !/[\\/:%\x00-\x1f]/.test(v));
export const PREVIEW_CHUNK = 1024 * 1024;
export const PREVIEW_TTL = 15 * 60_000;
export const previewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("package"), packageId: version, version, thumbnail: name.optional(), noCover: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("live"), video: name, music: name.optional(), coverId: z.string().uuid().optional() }).strict(),
]);
export const previewTargetSchema = z.object({ agentId: identifier, instanceId: identifier, accountId: z.string().uuid().optional(), channelId: z.string().min(1).max(128).optional() }).strict();
export type PreviewSource = z.infer<typeof previewSourceSchema>;
export type PreviewTarget = z.infer<typeof previewTargetSchema>;
export type PreviewSelection = PreviewTarget & { source: PreviewSource };
export const previewPartSchema = z.enum(["video", "music", "cover", "final"]);
export type PreviewPart = z.infer<typeof previewPartSchema>;
export const previewCommandSchema = z.object({
  id: z.string().uuid(), session: z.string().uuid(), expires: z.number(), target: previewTargetSchema,
  action: z.enum(["open", "bytes", "check", "status", "cancel", "prepare", "close"]), source: previewSourceSchema.optional(),
  part: previewPartSchema.optional(), offset: z.number().int().nonnegative().optional(), count: z.number().int().min(1).max(PREVIEW_CHUNK).optional(),
}).strict();
export type PreviewCommand = z.infer<typeof previewCommandSchema>;
export type PreviewCheck = { state: "pending" | "running" | "complete" | "failed" | "cancelled" | "unavailable"; coverage: "sample" | "full"; progress?: number; sound?: "absent" | "present" | "suspected-silent" | "unknown"; ranges?: { start: number; duration: number }[]; message?: string };
export type PreviewFile = { name: string; size: number; mime: string; version: string; duration?: number; width?: number; height?: number; video?: boolean; audio?: boolean; codec?: string; check?: PreviewCheck };
export type PreviewState = { files: Partial<Record<PreviewPart, PreviewFile>>; operation?: "quick" | "check" | "prepare"; busy: boolean; message?: string; error?: string; expires: number };
export type PreviewEnvelope = { data?: PreviewState; error?: string; code?: string; status?: number };

/** 单区间支持前缀、后缀与开放末尾；不支持多区间，避免放大临时中转内存。 */
export function previewRange(value: string | null, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("RANGE");
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) throw new Error("RANGE");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) throw new Error("RANGE");
  return { start, end, partial: true };
}
