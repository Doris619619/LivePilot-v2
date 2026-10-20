/** 管理员 YouTube 接口共享鉴权和严格筛选，不接受任意路径或上游文本。 */
import { z } from "zod";
import { authenticate, requireAdmin } from "@/server/access";
import { guard } from "@/server/http";
import { youtubeMethodSchema, youtubePurposeSchema, type YouTubeUsageQuery } from "@/shared/youtube-usage";
const querySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), agentId: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(), instanceId: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(), method: youtubeMethodSchema.optional(), purpose: youtubePurposeSchema.optional(), outcome: z.enum(["succeeded", "failed", "unknown", "cancelled"]).optional(), cursor: z.string().regex(/^\d+:[a-f0-9-]{36}$/).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().nonnegative().optional(), format: z.enum(["ndjson", "csv"]).optional() }).strict().refine(v => v.from === undefined || v.to === undefined || v.to >= v.from && v.to - v.from <= 31 * 86400_000, "时间范围须在31天内");
/** 复用既有Host、同源写保护及服务端管理员会话检查。 */
export async function youtubeAdmin(request: Request, mutation = false) { guard(request, mutation); const user = await authenticate(request); requireAdmin(user); return user; }
/** 查询与导出使用同一个严格解析，避免客户端筛选与下载不一致。 */
export function youtubeQuery(request: Request): YouTubeUsageQuery & { format?: "ndjson" | "csv" } { return querySchema.parse(Object.fromEntries(new URL(request.url).searchParams)); }
