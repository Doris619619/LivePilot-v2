/** 上传创建准备协议；短期准入凭据只授权原成员、目标与文件，不代表 Agent 已创建文件。 */
import { z } from "zod";
export const uploadInputSchema = z.object({ kind: z.enum(["videos", "music"]), filename: z.string().min(1).max(180), size: z.number().int().positive().safe().max(20 * 1024 ** 3), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const uploadPreparationSchema = z.object({ requestId: z.string().uuid(), credential: z.string().min(20).max(8192), expiresAt: z.number().int().positive() }).strict();
export type UploadPreparation = z.infer<typeof uploadPreparationSchema>;
export type UploadInput = z.infer<typeof uploadInputSchema>;
/** 新协议使用专属 UUIDv8 空间；过期记录清理后也不能退回无凭据的旧创建路径。 */
export function preparedUploadId(id: string) { return id[14] === "8"; }
