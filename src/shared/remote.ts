/** 云端与 Agent 的版本化白名单协议；浏览器 DTO 不含密钥和绝对路径。 */
import { z } from "zod";
import { jobSpecSchema, packageBatchSchema } from "./publishing";
import { aiBriefSchema, aiKeySchema } from "./broadcast-ai";
import { broadcastSchema, thumbnailInputSchema } from "./broadcast";
import type { Dashboard, InstanceDescriptor } from "./types";
import { problemSchema } from "./problems";
import { liveChatConfigSchema } from "./live-chat";
export const PROTOCOL = 1;
export const HEARTBEAT_MS = 5_000;
export const OFFLINE_MS = 20_000;
export const ACCEPT_MS = 60_000;
export const idSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).refine(v => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(v));
export const uuidSchema = z.string().uuid();
export const targetSchema = z.object({ agentId: idSchema, instanceId: idSchema });
export type Target = z.infer<typeof targetSchema>;
export const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), video: z.string().min(1).max(255), music: z.string().min(1).max(255), videoAudio: z.boolean(), broadcast: broadcastSchema.optional() }).strict(),
  z.object({ action: z.literal("stop") }).strict(), z.object({ action: z.literal("launch") }).strict(),
  z.object({ action: z.literal("clear-uncertain"), confirmed: z.literal(true) }).strict(),
]);
export const uploadInputSchema = z.object({ kind: z.enum(["videos", "music"]), filename: z.string().min(1).max(180), size: z.number().int().positive().max(20 * 1024 ** 3), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const taskPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live-chat-read") }).strict(),
  z.object({ kind: z.literal("live-chat-configure"), config: liveChatConfigSchema }).strict(),
  z.object({ kind: z.literal("publishing-packages"), accountId: uuidSchema.optional() }).strict(),
  z.object({ kind: z.literal("publishing-account-oauth-begin"), accountId: uuidSchema }).strict(),
  z.object({ kind: z.literal("publishing-account-oauth-finish"), accountId: uuidSchema, cookie: z.string().regex(/^[a-f0-9]{64}$/), state: z.string().max(160), code: z.string().max(4096), cancelled: z.boolean().optional(), expectedChannel: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict(),
  z.object({ kind: z.literal("publishing-account-playlists"), accountId: uuidSchema }).strict(),
  z.object({ kind: z.literal("publishing-archive"), batch: packageBatchSchema, archiveId: uuidSchema, accountId: uuidSchema.optional() }).strict(),
  z.object({ kind: z.literal("publishing-assets"), accountId: uuidSchema.optional() }).strict(),
  z.object({ kind: z.literal("publishing-apply"), job: jobSpecSchema }).strict(),
  z.object({ kind: z.literal("broadcast-ai-status") }).strict(),
  z.object({ kind: z.literal("broadcast-ai-key"), apiKey: aiKeySchema }).strict(),
  z.object({ kind: z.literal("broadcast-ai-generate"), brief: aiBriefSchema }).strict(),
  z.object({ kind: z.literal("broadcast-playlists") }).strict(),
  z.object({ kind: z.literal("broadcast-thumbnail"), input: thumbnailInputSchema }).strict(),
  z.object({ kind: z.literal("control"), input: controlSchema }).strict(),
  z.object({ kind: z.literal("oauth-begin") }).strict(),
  z.object({ kind: z.literal("oauth-finish"), cookie: z.string().regex(/^[a-f0-9]{64}$/), state: z.string().max(160), code: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("upload-create"), input: uploadInputSchema, uploadId: uuidSchema }).strict(),
  z.object({ kind: z.literal("upload-status"), uploadId: uuidSchema }).strict(),
  z.object({ kind: z.literal("upload-finish"), uploadId: uuidSchema }).strict(),
  z.object({ kind: z.literal("upload-cancel"), uploadId: uuidSchema }).strict(),
  z.object({ kind: z.literal("upload-chunk"), uploadId: uuidSchema, offset: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/), slot: uuidSchema, size: z.number().int().positive().max(8 * 1024 ** 2) }).strict(),
]);
export type TaskPayload = z.infer<typeof taskPayloadSchema>;
/** 独立账号指令与上传任务共用同一身份提取，清理时不能按宿主实例误删其他账号。 */
export function publishingTaskAccountId(payload: TaskPayload) { return "accountId" in payload ? payload.accountId : payload.kind === "publishing-apply" ? payload.job.profile.accountId : undefined; }
export const taskSchema = z.object({ protocol: z.literal(PROTOCOL), id: uuidSchema, agentId: idSchema, instanceId: idSchema, actor: z.string().regex(/^[A-Za-z0-9_]{2,32}$/), expiresAt: z.number(), payload: taskPayloadSchema });
export type RemoteTask = z.infer<typeof taskSchema>;
export type DeliveryState = "queued" | "delivering" | "accepted" | "running" | "succeeded" | "failed" | "interrupted" | "expired" | "uncertain";
export const reportSchema = z.object({ problem: problemSchema.optional(), id: uuidSchema, status: z.enum(["accepted", "running", "succeeded", "failed", "interrupted", "expired"]), result: z.unknown().optional(), error: z.string().max(500).optional(), httpStatus: z.number().int().min(400).max(599).optional() }).strict();
export type TaskReport = z.infer<typeof reportSchema>;
export type AgentSnapshot = { instance: InstanceDescriptor; dashboard: Dashboard; observedAt: number };
export type AgentDescriptor = { owner?: string; id: string; name: string; online: boolean; lastSeen: number; revoked: boolean; instances: InstanceDescriptor[]; paired?: boolean; maintenance?: boolean; pairedTo?: string };
/** 设备和实例共同构成浏览器草稿、面板及请求的唯一身份。 */
export function targetKey(target: { id: string; agentId?: string }) { return target.agentId ? `${target.agentId}:${target.id}` : target.id; }
