/** 登录与会话入口；内置成员与管理命令创建的成员使用相同的服务端认证。 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, cookieValue, login, logout, SESSION_COOKIE, webSession } from "@/server/access";
import { BROWSER_ACCOUNT_LIMIT, forgetActiveAccount, rememberedAccounts, rememberLogin, setAccountSession } from "@/server/browser-accounts";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 返回当前登录成员，不附带会话或账号存储数据。 */
export async function GET(request: Request) {
  try { guard(request); return NextResponse.json({ user: await authenticate(request) }, { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); }
}
/** 创建 12 小时会话，HTTPS 部署时始终启用 Secure Cookie。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    const parsed = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{2,32}$/), password: z.string().min(1).max(256) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "请输入有效账号和密码。");
    const remembered = await rememberedAccounts(request);
    if (remembered.values.length >= BROWSER_ACCOUNT_LIMIT && !remembered.values.some(value => value.user.username === parsed.data.username)) throw new AppError("ACCOUNT_LIMIT", "最多保留 6 个登录账号，请先退出一个账号。", 409);
    const result = await login(parsed.data.username, parsed.data.password);
    const response = NextResponse.json({ user: result.user }, { headers: { "Cache-Control": "no-store" } });
    await rememberLogin(request, response, result);
    return response;
  } catch (e) { return failed(e); }
}
/** 退出不会结束执行中的控制或上传完成校验。 */
export async function DELETE(request: Request) {
  try { guard(request, true); const active = await webSession(cookieValue(request, SESSION_COOKIE)); if (active) await authenticate(request); await logout(request); const response = NextResponse.json({ ok: true });
    setAccountSession(response, SESSION_COOKIE, "", 0); await forgetActiveAccount(request, response, active?.user.username); return response;
  } catch (e) { return failed(e); }
}
