/** 将 OAuth 回调交还发起实例；state、Cookie、磁盘事务三者必须匹配。 */
import { cloudMode } from "@/server/remote";
import { finishRemoteOAuth, oauthCookie, remoteOAuthContext } from "@/cloud/oauth";
import { authenticate, requireAdmin } from "@/server/access";
import { audit } from "@/server/audit";
import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/server/http";
import { config, requireInstance } from "@/server/config";
import { service } from "@/server/service";
import { safeError, AppError, problemFor } from "@/server/errors";
import { saveOAuthResult, type OAuthResult } from "@/server/oauth-result";
export const runtime = "nodejs";
/** 消费一次性授权并固定频道归属；有未结束场次时不能更换频道。 */
export async function GET(request: NextRequest) {
  let error: string | undefined;
  let id: string | undefined; let actor: string | undefined; let result:OAuthResult={target:{},status:"failed"};
  const cancelled=request.nextUrl.searchParams.get("error")==="access_denied";
  try {
    guard(request);
    const user = await authenticate(request); actor=user.username; if (!cloudMode()) requireAdmin(user);
    const oauthState = request.nextUrl.searchParams.get("state") || "";
    if (cloudMode()) {
      const cookieName = oauthCookie(oauthState);
      const context = await remoteOAuthContext(oauthState, request.cookies.get(cookieName)?.value || "", user.username); result = { target: { agentId: context.agentId, instanceId: context.instanceId }, ...(context.accountId ? { accountId: context.accountId } : {}), status: "failed" };
      const destination = await finishRemoteOAuth(oauthState, request.cookies.get(cookieName)?.value || "", user.username, request.nextUrl.searchParams.get("code") || "", user, cancelled);
      result={target:{agentId:destination.agentId,instanceId:destination.instanceId},...(destination.accountId ? {accountId:destination.accountId} : {}),status:cancelled?"cancelled":"connected"};
      const reference=await saveOAuthResult(user.username,result);
      const response = NextResponse.redirect(config().origin + (destination.accountId ? "/publishing?oauthResult=" + reference : "/workspace?oauthResult="+reference+"#instance-" + destination.agentId + "-" + destination.instanceId), 303);
      response.cookies.set(cookieName, "", { path: "/api/youtube", maxAge: 0, secure: true, httpOnly: true, sameSite: "lax" }); return response;
    }
    const match = /^([a-z][a-z0-9_]{0,31})\.[a-f0-9]{64}$/.exec(oauthState);
    if (!match) throw new AppError("OAUTH_STATE", "授权回调无效，请从对应 OBS 面板重新连接。");
    id = requireInstance(match[1]);
    result.target={instanceId:id}; const app = service(id);
    await app.commands.withIdle(() => app.control.exclusive(async () => {
      const state = await app.control.state();
      await app.auth.finish(request.cookies.get("livepilot_oauth_" + id)?.value || "", oauthState, request.nextUrl.searchParams.get("code") || "", state.phase !== "stopped" ? state.channelId : undefined, user.username, cancelled);
    }));
    await audit(user.username, "youtube-auth", id, cancelled?"cancelled":"connected");
    app.invalidate(); result.status=cancelled?"cancelled":"connected";
  } catch (e) { error = safeError(e); const problem=problemFor(e,{domain:"youtube",stage:"频道授权回调"});result={target:problem.target.instanceId?problem.target:result.target,...(result.accountId ? {accountId:result.accountId} : {}),status:result.status,problem:result.status==="connected"?{...problem,outcome:"completed",message:"频道授权已完成，但结果提示未能保存。请查询频道状态，无需重复授权。"}:problem}; }
  const reference=actor ? await saveOAuthResult(actor,result).catch(()=>undefined) : undefined;
  const destination=result.target; const anchor=destination.instanceId ? "#instance-"+(destination.agentId?destination.agentId+"-":"")+destination.instanceId : "";
  const response=NextResponse.redirect(config().origin+(result.accountId ? "/publishing" : "/workspace")+(reference?"?oauthResult="+reference:"")+(result.accountId ? "" : anchor),303);
  if (id) response.cookies.set("livepilot_oauth_" + id, "", { path: "/api/youtube", maxAge: 0, secure: config().origin.startsWith("https:"), httpOnly: true, sameSite: "lax" });
  // NextResponse 会编码 Cookie 值；手工编码会让页面单次解码后仍显示百分号字符串。
  if (error && !reference) response.cookies.set("livepilot_notice", error, { path: "/", maxAge: 120, sameSite: "strict" });
  return response;
}
