/** 已登录成员的同源设备邀请入口；不返回长期设备凭据。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authorizeAgent } from "@/server/ownership";
import { authenticate, members } from "@/server/access";
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
    guard(request, true); const user = await authenticate(request);
    if (!cloudMode()) throw new AppError("MODE", "请在云端网页添加直播电脑。");
    const value = z.object({ name: z.string().trim().min(1).max(80), agentId: idSchema.optional(), owner: z.string().optional() }).strict().parse(await readJson(request, 2048));
    if (value.agentId) await authorizeAgent(user, value.agentId);
    const owner = user.role === "customer" ? user.username : value.owner;
    if (!owner || !(await members()).some(m => m.username === owner && m.role === "customer")) throw new AppError("OWNER", "请选择设备所属客户。", 400);
    if (value.agentId && (await authorizeAgent(user, value.agentId)).owner !== owner) throw new AppError("OWNER", "请使用原客户账号恢复设备。", 403);
    const result = value.agentId ? await renewPairing(value.agentId) : await createPairing("pc_" + randomBytes(8).toString("hex"), value.name, owner);
    const invitation = "LN1." + Buffer.from(JSON.stringify({ origin: config().origin, agentId: result.agentId, code: result.code })).toString("base64url");
    return Response.json({ agentId: result.agentId, expiresInSeconds: 600, invitation }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请输入 1–80 字的电脑名称。") : e); }
}
