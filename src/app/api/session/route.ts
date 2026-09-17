/** 登录与会话入口；无公开注册，账号由直播电脑上的管理命令创建。 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, login, logout, SESSION_COOKIE } from "@/server/access";
import { guard, failed } from "@/server/http";
import { config } from "@/server/config";
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
    const parsed = z.object({ username: z.string().regex(/^[a-z0-9_]{3,32}$/), password: z.string().min(1).max(256) }).strict().safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "请输入有效账号和密码。");
    const result = await login(parsed.data.username, parsed.data.password);
    const response = NextResponse.json({ user: result.user }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, result.token, { httpOnly: true, secure: config().origin.startsWith("https:"), sameSite: "lax", path: "/", maxAge: 43200 });
    return response;
  } catch (e) { return failed(e); }
}
/** 退出不会结束执行中的控制或上传完成校验。 */
export async function DELETE(request: Request) {
  try { guard(request, true); await logout(request); const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: config().origin.startsWith("https:"), sameSite: "lax", path: "/", maxAge: 0 }); return response;
  } catch (e) { return failed(e); }
}
