/** 管理员安全调用明细：严格筛选和最多500条游标分页。 */
import { failed } from "@/server/http";
import { youtubeEvents } from "@/cloud/youtube-usage-events";
import { youtubeAdmin, youtubeQuery } from "../http";
export const runtime = "nodejs";
/** 从持久事件读取，不为查看明细请求任何Google接口。 */
export async function GET(request: Request) { try { await youtubeAdmin(request); return Response.json(await youtubeEvents(youtubeQuery(request)), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failed(error); } }
