/** 文件完整校验在 B 上继续，浏览器轮询实际状态。 */
import { after } from "next/server";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { prepareFinish, finishUpload, uploadFailure } from "@/server/uploads";
import { audit } from "@/server/audit";
export const runtime = "nodejs";
export const maxDuration = 600;
/** 可重试完成请求；不会覆盖已经存在的媒体。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    guard(request, true); const actor = (await authenticate(request)).username;
    const id = (await context.params).id;
    const instanceId = new URL(request.url).searchParams.get("instanceId") || "";
    const status = await prepareFinish(instanceId, actor, id);
    if (status.status !== "complete") after(async () => {
      try { await finishUpload(instanceId, actor, id); }
      catch (e) { await uploadFailure(instanceId, actor, id, e); await audit(actor, "upload", instanceId, "verification-incomplete", id); }
    });
    return Response.json(status, { status: status.status === "complete" ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
