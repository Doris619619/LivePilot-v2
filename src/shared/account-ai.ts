/** 账号 AI 用途开关与公开状态；浏览器只提交新密钥，不读取已有密钥。 */
import { z } from "zod";
import { aiKeySchema } from "./broadcast-ai";
export const aiUsesSchema = z.object({ copy: z.boolean(), chat: z.boolean() }).strict();
export const accountAiInputSchema = z.object({ revision: z.number().int().nonnegative(), uses: aiUsesSchema, apiKey: aiKeySchema.optional() }).strict();
export type AiUses = z.infer<typeof aiUsesSchema>;
export type AccountAiStatus = { revision: number; configured: boolean; managed: boolean; uses: AiUses };
