/** 文件完整校验在 B 上继续，浏览器轮询实际状态。 */
import { cloudMode, queryTarget, remoteFinish } from "@/server/remote";
import { after } from "next/server";
import { authorizeAgent } from "@/server/ownership";
import { authenticate, requireAdmin } from "@/server/access";
import { guard, failed } from "@/server/http";
import { prepareFinish, finishUpload, uploadFailure } from "@/server/uploads";
import { audit } from "@/server/audit";
export const runtime = "nodejs";
export const maxDuration = 600;
/** 可重试完成请求；不会覆盖已经存在的媒体。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    guard(request, true); const user = await authenticate(request); const actor = user.username; if (cloudMode()) await authorizeAgent(user, queryTarget(request).agentId); else requireAdmin(user);
    const id = (await context.params).id;
    const instanceId = new URL(request.url).searchParams.get("instanceId") || "";
    if (cloudMode()) return Response.json(await remoteFinish(queryTarget(request), actor, id), { status: 202, headers: { "Cache-Control": "no-store" } });
    const status = await prepareFinish(instanceId, actor, id);
    if (status.status !== "complete") after(async () => {
      try { await finishUpload(instanceId, actor, id); }
      catch (e) { await uploadFailure(instanceId, actor, id, e); await audit(actor, "upload", instanceId, "verification-incomplete", id); }
    });
    return Response.json(status, { status: status.status === "complete" ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
