/** 实例内加密聊天检查点；持久保存接收游标、有限队列和发送意图，重启不重发未知结果。 */
import { z } from "zod";
import { liveChatConfigSchema, liveChatEntrySchema } from "@/shared/live-chat";
import { Store, seal, unseal } from "../storage";
import { AppError } from "../errors";

export const messageSchema = z.object({ id: z.string().min(1).max(200), authorId: z.string().max(200), author: z.string().max(100), text: z.string().max(1000), publishedAt: z.number().int().nonnegative(), type: z.string().max(100), firstMessage: z.boolean().optional() });
const blockSchema = z.object({ code: z.string().max(50), until: z.number().int().nonnegative().optional(), target: z.string().optional() });
export const checkpointSchema = z.object({
  config: liveChatConfigSchema, enabledAt: z.number().int().nonnegative(), sessionAt: z.number().int().nonnegative(),
  target: z.string().optional(), chatId: z.string().optional(), pageToken: z.string().optional(),
  seen: z.array(z.object({ id: z.string(), at: z.number() })).max(10000),
  seenAuthors: z.array(z.string().max(200)).max(10000).default([]),
  spam: z.array(z.object({ key: z.string(), at: z.number() })).max(10000),
  queue: z.array(messageSchema).max(100), recent: z.array(liveChatEntrySchema).max(30),
  sending: z.object({ message: messageSchema, reply: z.string().max(200), at: z.number() }).optional(),
  receipts: z.array(z.object({ messageId: z.string().max(200), sentMessageId: z.string().min(1).max(200), at: z.number(), target: z.string().optional() })).max(30).default([]),
  sent: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), lastAttemptAt: z.number().nonnegative(), block: blockSchema.optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

/** 缺检查点才采用首次启用默认值；损坏记录必须保留并明确报错。 */
export async function readCheckpoint(store: Store, now: number): Promise<Checkpoint> {
  const encrypted = await store.read<string>("live-chat.enc");
  if (!encrypted) return checkpointSchema.parse({ config: {}, enabledAt: now, sessionAt: now, seen: [], spam: [], queue: [], recent: [], sent: 0, skipped: 0, lastAttemptAt: 0 });
  const result = checkpointSchema.safeParse(unseal<unknown>(encrypted));
  if (!result.success) throw new AppError("CHAT_STORAGE", "聊天检查点无法读取，请在原电脑检查数据；不要删除记录后重复回复。", 409);
  return result.data;
}

/** 全部变更用一个原子密文写入，游标不会先于去重和队列落盘。 */
export async function writeCheckpoint(store: Store, checkpoint: Checkpoint) { await store.write("live-chat.enc", seal(checkpointSchema.parse(checkpoint))); }
