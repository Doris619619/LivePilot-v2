/** 管理员全项目配额与调用汇总：仅读取本应用账本。 */
import { failed } from "@/server/http";
import { youtubeUsageSummary } from "@/cloud/youtube-usage";
import { youtubeAdmin, youtubeQuery } from "./http";
export const runtime = "nodejs";
/** 返回不可缓存的预算、调用排名、覆盖率与日志缺失标记。 */
export async function GET(request: Request) { try { await youtubeAdmin(request); return Response.json(await youtubeUsageSummary(youtubeQuery(request).day), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failed(error); } }
