/** 返回本机状态或带设备新鲜度的云端快照。 */
/** 所有状态读取均要求有效成员会话。 */
import { cloudMode, queryTarget, remoteDashboard } from "@/server/remote";
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
