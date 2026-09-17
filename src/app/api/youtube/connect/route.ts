/** 从明确的实例面板发起 OAuth；每个实例使用独立浏览器事务 Cookie。 */
import { authenticate } from "@/server/access";
import { readJson } from "@/server/request-body";
import { audit } from "@/server/audit";
import { config } from "@/server/config";
import { NextResponse } from "next/server";
import { guard, failed } from "@/server/http";
import { requireInstance } from "@/server/config";
import { service } from "@/server/service";
export const runtime = "nodejs";
/** 校验目标后保存 PKCE 事务，不在浏览器暴露客户端密钥。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    const user = await authenticate(request);
    const body = await readJson(request, 512) as { instanceId?: unknown };
    const id = requireInstance(body?.instanceId);
    const app = service(id);
    const result = await app.commands.withIdle(() => app.control.exclusive(() => app.auth.begin(user.username)));
    await audit(user.username, "youtube-auth", id, "started");
    const response = NextResponse.json({ url: result.url });
    response.cookies.set("livepilot_oauth_" + id, result.cookie, { httpOnly: true, sameSite: "lax", secure: config().origin.startsWith("https:"), path: "/api/youtube", maxAge: 600 });
    return response;
  } catch (e) { return failed(e); }
}
