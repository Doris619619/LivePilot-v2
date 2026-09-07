/** 将 OAuth 回调交还发起实例；state、Cookie、磁盘事务三者必须匹配。 */
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
    const oauthState = request.nextUrl.searchParams.get("state") || "";
    const match = /^([a-z][a-z0-9_]{0,31})\.[a-f0-9]{64}$/.exec(oauthState);
    if (!match) throw new AppError("OAUTH_STATE", "授权回调无效，请从对应 OBS 面板重新连接。");
    id = requireInstance(match[1]);
    const app = service(id);
    await app.control.exclusive(async () => {
      const state = await app.control.state();
      await app.auth.finish(request.cookies.get("livepilot_oauth_" + id)?.value || "", oauthState, request.nextUrl.searchParams.get("code") || "", state.phase !== "stopped" ? state.channelId : undefined);
    });
    app.invalidate();
  } catch (e) { error = safeError(e); }
  const response = NextResponse.redirect(config().origin + (error ? "/?oauth=failed" : "/?oauth=connected") + (id ? "#instance-" + id : ""), 303);
  if (id) response.cookies.set("livepilot_oauth_" + id, "", { path: "/api/youtube", maxAge: 0, httpOnly: true, sameSite: "lax" });
  if (error) response.cookies.set("livepilot_notice", encodeURIComponent(error), { path: "/", maxAge: 120, sameSite: "strict" });
  return response;
}
