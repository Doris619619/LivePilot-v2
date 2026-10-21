/** 返回本机状态或带设备新鲜度的云端快照。 */
/** 所有状态读取均要求有效成员会话。 */
import { cloudMode, queryTarget, remoteDashboard, checkRemoteYouTube } from "@/server/remote";
import { authorizeAgent } from "@/server/ownership";
import { authenticate, requireAdmin } from "@/server/access";
/** 单实例状态入口：慢速实例不会阻塞其他面板轮询。 */
import { service } from "@/server/service";
import { guard, failed } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 返回经过筛选的状态 DTO，不暴露 OBS 路径或 Secret。 */
export async function GET(request: Request) {
  try { guard(request); const user = await authenticate(request); if (cloudMode()) await authorizeAgent(user, queryTarget(request).agentId); else requireAdmin(user); return Response.json(cloudMode() ? await remoteDashboard(queryTarget(request)) : await service(new URL(request.url).searchParams.get("instanceId") || "main").dashboard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return failed(e); }
}
/** 显式人工核对走受预算管理的Agent RPC；普通GET/心跳仍读取缓存，写级同源防护避免跨站消耗额度。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    if (cloudMode()) {
      const destination = queryTarget(request); await authorizeAgent(user, destination.agentId);
      const result = await checkRemoteYouTube(destination, user.username); await authorizeAgent(user, destination.agentId);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    requireAdmin(user);
    return Response.json(await service(new URL(request.url).searchParams.get("instanceId") || "main").checkYouTube(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
