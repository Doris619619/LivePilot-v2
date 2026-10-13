/** 直播 AI 互动的配置、公开状态和消息端口；所有浏览器字段均不包含授权凭据。 */
import { z } from "zod";

export const liveChatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(["friendly", "playful", "gentle", "custom"]).default("friendly"),
  customPrompt: z.string().max(2000).default(""),
  intervalSeconds: z.number().int().min(5).max(60).default(5),
}).strict();
export type LiveChatConfig = z.infer<typeof liveChatConfigSchema>;
export const defaultLiveChatConfig: LiveChatConfig = liveChatConfigSchema.parse({});
export const liveChatEntrySchema = z.object({
  id: z.string().min(1).max(200), author: z.string().max(100), authorId: z.string().max(200).optional(), text: z.string().max(1000),
  reply: z.string().max(200).optional(),
  status: z.enum(["queued", "sent", "skipped", "uncertain", "failed"]),
  at: z.number().int().nonnegative(), reason: z.string().max(300).optional(),
});
export type LiveChatEntry = z.infer<typeof liveChatEntrySchema>;
export const liveChatStatusSchema = z.object({
  config: liveChatConfigSchema, configured: z.boolean(),
  state: z.enum(["disabled", "needs_key", "waiting_live", "connecting", "running", "reconnecting", "needs_attention", "unavailable", "quota_wait"]),
  message: z.string().max(500), sent: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  queued: z.number().int().min(0).max(100), recent: z.array(liveChatEntrySchema).max(30),
  nextRetryAt: z.number().int().nonnegative().optional(), updatedAt: z.number().int().nonnegative(),
  recoveryAction: z.enum(["authorize", "contact_admin", "check_storage"]).optional(),
});
export type LiveChatStatus = z.infer<typeof liveChatStatusSchema>;
export type LiveChatMessage = { id: string; authorId: string; author: string; text: string; publishedAt: number; type: string; firstMessage?: boolean };
export type LiveChatBatch = { messages: LiveChatMessage[]; nextPageToken?: string; offlineAt?: string };
export type LiveChatTarget = { channelId?: string; broadcastId?: string; live: boolean; liveChatId?: string; available?: boolean };
/** 可注入的聊天 I/O；运行器只获得聊天能力，不获得 OBS 或开停播工具。 */
export interface LiveChatPorts {
  observe(): Promise<LiveChatTarget>;
  configured(): Promise<boolean>;
  stream(chatId: string, pageToken: string | undefined, signal: AbortSignal): AsyncIterable<LiveChatBatch>;
  generate(config: LiveChatConfig, message: LiveChatMessage, context: LiveChatEntry[], signal: AbortSignal): Promise<string>;
  send(chatId: string, text: string, signal: AbortSignal): Promise<{ id: string }>;
  now?(): number;
}
