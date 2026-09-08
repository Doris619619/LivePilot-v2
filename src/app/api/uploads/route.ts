/** 已登录成员创建媒体上传；实例与目标库来自服务端配置。 */
import { z } from "zod";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { createUpload } from "@/server/uploads";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
/** 预留容量后返回上传记录，文件本体使用分片入口。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    const parsed = z.object({ instanceId: z.string(), kind: z.enum(["videos", "music"]), filename: z.string().min(1).max(180), size: z.number().int().positive(), fingerprint: z.string().length(64) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "上传信息无效。");
    const { instanceId, ...input } = parsed.data;
    return Response.json(await createUpload(instanceId, user.username, input), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
