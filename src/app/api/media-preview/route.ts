/** 登录浏览器的专用预览入口；素材标识白名单、同源写入与逐次 Range 鉴权。 */
import { z } from "zod";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { openPreview, updatePreview, readPreview } from "@/server/media-preview";
import { previewSourceSchema, previewTargetSchema, previewPartSchema } from "@/shared/media-preview";
import { AppError } from "@/core/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), selection: previewTargetSchema.extend({ source: previewSourceSchema }) }).strict(),
  z.object({ action: z.enum(["status", "check", "prepare", "cancel", "close"]), id: z.string().uuid() }).strict(),
]);
/** 动作仅操作当前登录会话，不接收文件路径、任意 URL 或上传指令。 */
export async function POST(request: Request) {
  try { guard(request, true); const parsed = bodySchema.safeParse(await readJson(request, 8192)); if (!parsed.success) throw new AppError("INPUT", "预览请求无效。"); const body = parsed.data; return Response.json(body.action === "open" ? await openPreview(request, body.selection) : await updatePreview(request, body.id, body.action), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failed(error); }
}
/** 图片、视频与音乐共用受限读取；失败不转换为伪造的正常媒体。 */
export async function GET(request: Request) {
  try { guard(request); const url = new URL(request.url); const id = z.string().uuid().safeParse(url.searchParams.get("id")); const part = previewPartSchema.safeParse(url.searchParams.get("part")); if (!id.success || !part.success) throw new AppError("INPUT", "预览读取参数无效。"); return await readPreview(request, id.data, part.data); } catch (error) { return failed(error); }
}
export const HEAD = GET;
