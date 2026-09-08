/** 上传续传、查询与取消；每次请求都验证成员和实例归属。 */
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { uploadStatus, uploadChunk, cancelUpload } from "@/server/uploads";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
/** 验证请求后提取固定上传身份，禁止浏览器传入磁盘路径。 */
async function identity(request: Request, context: Context, mutation = false) {
  guard(request, mutation); const actor = (await authenticate(request)).username;
  return { actor, id: (await context.params).id, instanceId: new URL(request.url).searchParams.get("instanceId") || "" };
}
/** 返回已确认字节，未登录不暴露素材名称。 */
export async function GET(request: Request, context: Context) {
  try { const p = await identity(request, context); return Response.json(await uploadStatus(p.instanceId, p.actor, p.id), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); }
}
/** 每次提交一个有界分片，由服务端流式写入。 */
export async function PUT(request: Request, context: Context) {
  try {
    const p = await identity(request, context, true);
    if (request.headers.get("content-type") !== "application/octet-stream" || !request.headers.has("upload-offset")) throw new AppError("INPUT", "请使用有效的二进制分片。");
    return Response.json(await uploadChunk(p.instanceId, p.actor, p.id, Number(request.headers.get("upload-offset")), request.headers.get("upload-sha256") || "", request));
  } catch (e) { return failed(e); }
}
/** 取消只影响临时文件，直播素材和直播状态保留。 */
export async function DELETE(request: Request, context: Context) {
  try { const p = await identity(request, context, true); await cancelUpload(p.instanceId, p.actor, p.id); return Response.json({ ok: true }); } catch (e) { return failed(e); }
}
