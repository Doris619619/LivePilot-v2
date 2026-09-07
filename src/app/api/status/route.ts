/** 单实例状态入口：慢速实例不会阻塞其他面板轮询。 */
import { service } from "@/server/service";
import { guard, failed } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 返回经过筛选的状态 DTO，不暴露 OBS 路径或 Secret。 */
export async function GET(request: Request) {
  try { guard(request); return Response.json(await service(new URL(request.url).searchParams.get("instanceId") || "main").dashboard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return failed(e); }
}
