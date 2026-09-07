/** 从明确的实例面板发起 OAuth；每个实例使用独立浏览器事务 Cookie。 */
import { NextResponse } from "next/server";
import { guard, failed } from "@/server/http";
import { requireInstance } from "@/server/config";
import { service } from "@/server/service";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
/** 校验目标后保存 PKCE 事务，不在浏览器暴露客户端密钥。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INPUT", "请求必须是 JSON。");
    const text = await request.text();
    if (text.length > 512) throw new AppError("INPUT", "请求过大。");
    let body: { instanceId?: unknown };
    try { body = JSON.parse(text); } catch { throw new AppError("INPUT", "请求格式无效。"); }
    const id = requireInstance(body?.instanceId);
    const app = service(id);
    const result = await app.control.exclusive(() => app.auth.begin());
    const response = NextResponse.json({ url: result.url });
    response.cookies.set("livepilot_oauth_" + id, result.cookie, { httpOnly: true, sameSite: "lax", secure: false, path: "/api/youtube", maxAge: 600 });
    return response;
  } catch (e) { return failed(e); }
}
