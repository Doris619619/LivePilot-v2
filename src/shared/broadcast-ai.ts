/** DeepSeek 文案生成的有限输入与公开输出；密钥不会出现在结果类型中。 */
import { z } from "zod";
import { broadcastSchema } from "./broadcast";
export const aiBriefSchema = z.string().trim().min(1).max(500);
export const aiKeySchema = z.string().trim().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const aiCopySchema = z.object({
  title: broadcastSchema.shape.title,
  description: broadcastSchema.shape.description.refine(v => v.trim().length > 0),
}).strict().refine(v => !/[\u3400-\u9fff]/.test(v.title + v.description), "生成文案必须为英文");
export type AiCopy = z.infer<typeof aiCopySchema>;
