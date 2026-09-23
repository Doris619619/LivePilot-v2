/** 管理员数据接口；客户即使直接请求 URL 也无法读取。 */
import { authenticate, requireAdmin } from "@/server/access";
import { guard, failed } from "@/server/http";
import { overview } from "@/cloud/overview";
export const runtime = "nodejs";
/** 返回不可缓存的全局状态。 */
export async function GET(request: Request) { try { guard(request); requireAdmin(await authenticate(request)); return Response.json(await overview(), { headers: { "Cache-Control": "no-store" } }); } catch(e) { return failed(e); } }
