/** 桌面凭原设备证明核对或删除绑定；已删除设备不再要求旧客户归属。 */
import { z } from "zod";
import { authenticate } from "@/server/access";
import { cloudMode, config } from "@/core/config";
import { AppError } from "@/core/errors";
import { inspectBinding, deleteAgent } from "@/cloud/agents";
import { failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { idSchema } from "@/shared/remote";
export const runtime = "nodejs";
/** 客户会话与设备凭据分别验证；正文和返回值均不进入日志。 */
export async function POST(request: Request) {
  try {
    if (!cloudMode() || request.headers.get("host") !== new URL(config().origin).host || request.headers.has("origin")) throw new AppError("ORIGIN", "桌面请求来源无效。", 403);
    const user = await authenticate(request, true);
    const value = z.object({ agentId: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/), remove: z.boolean().optional() }).strict().parse(await readJson(request, 2048));
    const status = await inspectBinding(value.agentId, value.token, user.username);
    if (value.remove && status === "active") await deleteAgent(value.agentId, user.username, value.token);
    return Response.json({ status: value.remove ? "deleted" : status }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "设备绑定请求无效。") : e); }
}
