/** 上传创建专属准备/终结入口；已认证账号与目标绑定，准备本身不会操作 Agent 文件。 */
import { z } from "zod";
import { cloudMode, target } from "@/server/remote";
import { authenticate, requireAdmin } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { AppError } from "@/server/errors";
import { closeUploadAdmission, prepareUploadAdmission } from "@/cloud/upload-admission";
import { uploadInputSchema, uploadPreparationSchema } from "@/shared/upload-admission";
export const runtime = "nodejs";
const destinationSchema = z.object({ agentId: z.string().optional(), instanceId: z.string() }).strict();
/** 同源成员只为自己有权访问的目标准备；离线不投递任何任务。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const parsed = z.object({ destination: destinationSchema, input: uploadInputSchema }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "上传准备信息无效，请选择有内容且大小符合限制的文件。");
    const input = parsed.data;
    const destination: { agentId?: string; instanceId: string } = cloudMode() ? target(input.destination) : { instanceId: input.destination.instanceId };
    if (!cloudMode() && input.destination.agentId) throw new AppError("INPUT", "本机上传不能指定远程设备。");
    if (destination.agentId) await authorizeAgent(user, destination.agentId);
    return Response.json(await prepareUploadAdmission(user.username, destination, input.input), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
/** 仅凭服务端持久的同一准备状态返回未受理；未知和历史旧 ID 不可被这一入口清除。 */
export async function DELETE(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const parsed = z.object({ destination: destinationSchema, preparation: uploadPreparationSchema }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "原上传准备句柄不完整，尚未确认取消。");
    const input = parsed.data;
    const destination: { agentId?: string; instanceId: string } = cloudMode() ? target(input.destination) : { instanceId: input.destination.instanceId };
    if (!cloudMode() && input.destination.agentId) throw new AppError("INPUT", "本机上传不能指定远程设备。");
    // 终结未受理准备只修改本人短期凭据；设备移除后仍可终结，已受理上传仍须原设备确认取消。
    return Response.json(await closeUploadAdmission(user.username, destination, input.preparation), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
