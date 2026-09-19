/** 已登录成员创建媒体上传；实例与目标库来自服务端配置。 */
import { cloudMode, target, uploadRpc, queryTarget } from "@/server/remote";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { createUpload } from "@/server/uploads";
import { uploadRecovery } from "@/cloud/upload-recovery";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
/** 预留容量后返回上传记录，文件本体使用分片入口。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    const parsed = z.object({ agentId: z.string().optional(), requestId: z.string().uuid().optional(), instanceId: z.string(), kind: z.enum(["videos", "music"]), filename: z.string().min(1).max(180), size: z.number().int().positive(), fingerprint: z.string().length(64) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "上传信息无效。");
    const { agentId, instanceId, requestId, ...input } = parsed.data;
    if (cloudMode()) { const id = requestId || randomUUID(); return Response.json(await uploadRpc(target({ agentId, instanceId }), user.username, { kind: "upload-create", input, uploadId: id }, id), { status: 201, headers: { "Cache-Control": "no-store" } }); }
    return Response.json(await createUpload(instanceId, user.username, input, requestId), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}

/** 根据已登录账号和设备查询未结算上传，创建响应丢失后仍能找回身份。 */
export async function GET(request: Request) {
  try {
    guard(request); const user = await authenticate(request);
    if (!cloudMode()) return Response.json([]);
    return Response.json(await uploadRecovery(queryTarget(request), user.username), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
