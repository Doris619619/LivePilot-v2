/** 已登录成员创建媒体上传；实例与目标库来自服务端配置。 */
import { cloudMode, target, queryTarget } from "@/server/remote";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorizeAgent } from "@/server/ownership";
import { authenticate, requireAdmin } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { createUpload } from "@/server/uploads";
import { uploadRecovery } from "@/cloud/upload-recovery";
import { AppError } from "@/server/errors";
import { acceptLocalUpload } from "@/cloud/upload-admission";
import { preparedUploadId, uploadPreparationSchema } from "@/shared/upload-admission";
import { rpc } from "@/cloud/tasks";
export const runtime = "nodejs";
/** 预留容量后返回上传记录，文件本体使用分片入口。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const parsed = z.object({ agentId: z.string().optional(), requestId: z.string().uuid().optional(), preparation: uploadPreparationSchema.optional(), instanceId: z.string(), kind: z.enum(["videos", "music"]), filename: z.string().min(1).max(180), size: z.number().int().positive(), fingerprint: z.string().length(64) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "上传信息无效。");
    const { agentId, instanceId, requestId, preparation, ...input } = parsed.data;
    if (preparation && preparation.requestId !== requestId || requestId && preparedUploadId(requestId) && !preparation) throw new AppError("UPLOAD_ADMISSION", "上传准备身份不一致。", 409);
    if (cloudMode()) { const destination = target({ agentId, instanceId }); await authorizeAgent(user, destination.agentId); const id = requestId || randomUUID(); const result = await rpc<Record<string, unknown>>(destination, user.username, { kind: "upload-create", input, uploadId: id }, id, preparation?.credential); return Response.json({ ...result, agentId: destination.agentId }, { status: 201, headers: { "Cache-Control": "no-store" } }); }
    if (agentId) throw new AppError("INPUT", "本机上传不能指定远程设备。");
    const create = () => createUpload(instanceId, user.username, input, requestId);
    return Response.json(await (preparation ? acceptLocalUpload(user.username, { instanceId }, input, preparation, create) : create()), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}

/** 根据已登录账号和设备查询未结算上传，创建响应丢失后仍能找回身份。 */
export async function GET(request: Request) {
  try {
    guard(request); const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    if (!cloudMode()) return Response.json([]);
    await authorizeAgent(user, queryTarget(request).agentId);
    return Response.json(await uploadRecovery(queryTarget(request), user.username), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
