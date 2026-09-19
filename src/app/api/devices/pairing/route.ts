/** 已登录成员的同源设备邀请入口；不返回长期设备凭据。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { cloudMode, config } from "@/core/config";
import { AppError } from "@/core/errors";
import { createPairing, renewPairing } from "@/cloud/agents";
import { idSchema } from "@/shared/remote";
export const runtime = "nodejs";
/** 新建设备使用随机标识；已移除设备可发恢复邀请，仍须提供原电脑凭据。 */
export async function POST(request: Request) {
  try {
    guard(request, true); await authenticate(request);
    if (!cloudMode()) throw new AppError("MODE", "请在云端网页添加直播电脑。");
    const value = z.object({ name: z.string().trim().min(1).max(80), agentId: idSchema.optional() }).strict().parse(await readJson(request, 2048));
    const result = value.agentId ? await renewPairing(value.agentId) : await createPairing("pc_" + randomBytes(8).toString("hex"), value.name);
    const invitation = "LN1." + Buffer.from(JSON.stringify({ origin: config().origin, agentId: result.agentId, code: result.code })).toString("base64url");
    return Response.json({ agentId: result.agentId, expiresInSeconds: 600, invitation }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请输入 1–80 字的电脑名称。") : e); }
}
