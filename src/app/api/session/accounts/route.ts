/** 同源浏览器账号列表与切换；只接受已有登录证明，不提供管理员代登。 */
import { z } from "zod";
import { browserAccountView, switchBrowserAccount } from "@/server/browser-accounts";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 列表没有活动身份时仍可选择有效的备用账号，凭据不随列表返回。 */
export async function GET(request: Request) {
  try { guard(request); return Response.json(await browserAccountView(request), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); }
}
/** 激活用户明确选择的已有会话，仍遵守同源写请求保护。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const value = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{2,32}$/) }).strict().safeParse(await readJson(request));
    if (!value.success) throw new AppError("INPUT", "请选择已登录账号。");
    return await switchBrowserAccount(request, value.data.username);
  } catch (e) { return failed(e); }
}
