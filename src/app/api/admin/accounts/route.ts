/** 管理员客户账号入口：同源校验、最小公开字段、禁止通过参数提权。 */
import { z } from "zod";
import { authenticate, requireAdmin, customerAccounts, changeCustomer } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { AppError } from "@/core/errors";
export const runtime = "nodejs";
/** 返回客户列表，所有响应禁止缓存。 */
export async function GET(request: Request) {
  try { guard(request); requireAdmin(await authenticate(request)); return Response.json({ accounts: await customerAccounts() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return failed(e); }
}
/** 请求仅包含动作、客户名称及新密码；写入前再次校验管理员会话。 */
export async function POST(request: Request) {
  try {
    guard(request, true); requireAdmin(await authenticate(request));
    const value = z.object({ action: z.enum(["create", "reset"]), username: z.string().max(32), password: z.string().max(256) }).strict().parse(await readJson(request));
    const account = await changeCustomer(request, value.action, value.username, value.password);
    return Response.json({ account }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请检查账号和密码输入，不支持更改账号角色。", 400) : e); }
}
