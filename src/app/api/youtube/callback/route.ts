/** 将 OAuth 回调交还发起实例；state、Cookie、磁盘事务三者必须匹配。 */
import { cloudMode } from "@/server/remote";
import { finishRemoteOAuth, oauthCookie } from "@/cloud/oauth";
import { authenticate, requireAdmin } from "@/server/access";
import { audit } from "@/server/audit";
import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/server/http";
import { config, requireInstance } from "@/server/config";
import { service } from "@/server/service";
import { safeError, AppError } from "@/server/errors";
export const runtime = "nodejs";
/** 消费一次性授权并固定频道归属；有未结束场次时不能更换频道。 */
export async function GET(request: NextRequest) {
  let error: string | undefined;
  let id: string | undefined;
  try {
    guard(request);
    const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const oauthState = request.nextUrl.searchParams.get("state") || "";
    if (cloudMode()) {
      const cookieName = oauthCookie(oauthState);
      const destination = await finishRemoteOAuth(oauthState, request.cookies.get(cookieName)?.value || "", user.username, request.nextUrl.searchParams.get("code") || "", user);
      const response = NextResponse.redirect(config().origin + "/?oauth=connected#instance-" + destination.agentId + "-" + destination.instanceId, 303);
      response.cookies.set(cookieName, "", { path: "/api/youtube", maxAge: 0, secure: true, httpOnly: true, sameSite: "lax" }); return response;
    }
    const match = /^([a-z][a-z0-9_]{0,31})\.[a-f0-9]{64}$/.exec(oauthState);
    if (!match) throw new AppError("OAUTH_STATE", "授权回调无效，请从对应 OBS 面板重新连接。");
    id = requireInstance(match[1]);
    const app = service(id);
    await app.commands.withIdle(() => app.control.exclusive(async () => {
      const state = await app.control.state();
      await app.auth.finish(request.cookies.get("livepilot_oauth_" + id)?.value || "", oauthState, request.nextUrl.searchParams.get("code") || "", state.phase !== "stopped" ? state.channelId : undefined, user.username);
    }));
    await audit(user.username, "youtube-auth", id, "connected");
    app.invalidate();
  } catch (e) { error = safeError(e); }
  const response = NextResponse.redirect(config().origin + (error ? "/?oauth=failed" : "/?oauth=connected") + (id ? "#instance-" + id : ""), 303);
  if (id) response.cookies.set("livepilot_oauth_" + id, "", { path: "/api/youtube", maxAge: 0, secure: config().origin.startsWith("https:"), httpOnly: true, sameSite: "lax" });
  // NextResponse 会编码 Cookie 值；手工编码会让页面单次解码后仍显示百分号字符串。
  if (error) response.cookies.set("livepilot_notice", error, { path: "/", maxAge: 120, sameSite: "strict" });
  return response;
}
