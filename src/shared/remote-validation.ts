/** 对 Agent 上报字段逐一白名单校验，剔除本机路径及任意附加字段。 */
import { z } from "zod";
import { idSchema, uuidSchema } from "./remote";
import { problemSchema } from "./problems";
const text = z.string().max(500);
export const operationSchema = z.object({ problem: problemSchema.optional(), id: uuidSchema, action: text, actor: text, status: z.enum(["accepted", "running", "succeeded", "failed", "interrupted", "queued", "delivering", "uncertain", "expired"]), updatedAt: text, message: text.optional() });
const selection = z.object({ video: text, music: text, videoAudio: z.boolean() });
export const dashboardSchema = z.object({
  problems: z.array(problemSchema).max(64).optional(), operation: operationSchema.optional(), busy: z.boolean(),
  state: z.object({ phase: z.enum(["idle", "starting", "live", "stopping", "stopped", "error"]), stage: text, updatedAt: text, error: text.optional(), channelId: text.optional(), broadcastId: text.optional(), streamId: text.optional(), broadcastTitle: text.optional(), streamTitle: text.optional(), broadcastIntent: z.boolean().optional(), streamIntent: z.boolean().optional(), obsStartRequested: z.boolean().optional(), selection: selection.optional(), startedAt: text.optional() }),
  obs: z.object({ problem: problemSchema.optional(), processKnown: z.boolean().optional(), ready: z.boolean(), running: z.boolean(), streaming: z.boolean().nullable(), reconnecting: z.boolean().optional(), durationMs: z.number().optional(), scene: text.optional(), version: text.optional(), message: text.optional() }),
  youtube: z.object({ problem: problemSchema.optional(), authorization: z.enum(["missing","present","invalid"]).optional(), query: z.enum(["ready","failed"]).optional(), connected: z.boolean(), channel: text.optional(), channelId: text.optional(), ingest: text.optional(), lifecycle: text.optional(), checkedAt: text.optional(), error: text.optional() }),
  media: z.object({ problems: z.array(problemSchema).max(2).optional(), videos: z.array(text).max(2000), music: z.array(text).max(2000), error: text.optional() }),
  configuration: z.object({ missing: z.array(text).max(30), privacy: text, madeForKids: z.boolean() }),
});
export const snapshotSchema = z.object({ instance: z.object({ id: idSchema, name: z.string().min(1).max(80) }), dashboard: dashboardSchema, observedAt: z.number().int().positive() });
export const uploadStatusSchema = z.object({ problem: problemSchema.optional(), verification: z.enum(["running","failed"]).optional(), id: uuidSchema, instanceId: idSchema, kind: z.enum(["videos", "music"]), filename: text, size: z.number().positive(), received: z.number().nonnegative(), chunkSize: z.number().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(["uploading", "verifying", "complete"]), expiresAt: z.number(), publishedName: text.optional(), error: text.optional() });
