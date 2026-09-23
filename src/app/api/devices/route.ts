/** 已登录成员移除云端设备并释放频道归属；保留本机数据和待核对任务。 */
import { z } from "zod";
import { authorizeAgent } from "@/server/ownership";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { cloudMode } from "@/core/config";
import { AppError } from "@/core/errors";
import { revokeAgent } from "@/cloud/agents";
import { idSchema } from "@/shared/remote";
export const runtime = "nodejs";
/** 显式确认具体目标后撤销通信；不发送停播或删除磁盘文件命令。 */
export async function DELETE(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    if (!cloudMode()) throw new AppError("MODE", "请在云端网页移除直播电脑。");
    const value = z.object({ agentId: idSchema, confirmed: z.literal(true) }).strict().parse(await readJson(request, 2048));
    await authorizeAgent(user, value.agentId);
    await revokeAgent(value.agentId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请确认要移除的电脑。") : e); }
}
