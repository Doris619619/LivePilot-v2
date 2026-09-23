/** 云端 OAuth 事务桥：浏览器 cookie 绑定成员及设备，令牌交换在 Agent 完成。 */
import type { Member } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { randomBytes, createHash } from "node:crypto";
import { isIP } from "node:net";
import { config } from "@/core/config";
import { seal, unseal } from "@/core/storage";
import { AppError, problemFor } from "@/core/errors";
import { cloudStore, transaction } from "./store";
import { rpc } from "./tasks";
import type { Target } from "@/shared/remote";
type OAuth = { target: Target; actor: string; browserHash: string; state: string; cookie: string; expires: number; used: boolean };
/** cookie 名包含随机事务标识，允许多台电脑同时发起独立授权。 */
export function oauthCookie(state: string) { if (!/^[a-f0-9]{64}$/.test(state)) throw new AppError("OAUTH", "授权回调无效。"); return "livepilot_cloud_oauth_" + state.slice(0, 16); }
/** IP 网站明确引导到本地授权，不跳转到注定失败的 Google 回调。 */
export async function beginRemoteOAuth(target: Target, actor: string) {
  if (isIP(new URL(config().origin).hostname)) throw new AppError("OAUTH_DOMAIN", "Google 不支持公网 IP 回调。请先在直播电脑本地连接频道，再启动 Agent；以后配置域名可在此授权。");
  const result = await rpc<{ url: string; cookie: string }>(target, actor, { kind: "oauth-begin" });
  const url = new URL(result.url); const agentState = url.searchParams.get("state") || "";
  if (url.searchParams.get("redirect_uri") !== config().redirectUri) throw new AppError("OAUTH_CONFIG", "Agent 的控制端地址与云端不一致，请检查配置。");
  const state = randomBytes(32).toString("hex"); const cookie = randomBytes(32).toString("hex");
  await cloudStore().write("oauth-" + state + ".json", seal({ target, actor, browserHash: createHash("sha256").update(cookie).digest("hex"), state: agentState, cookie: result.cookie, expires: Date.now() + 600_000, used: false } satisfies OAuth));
  url.searchParams.set("state", state); return { url: url.toString(), state, cookie };
}
/** 一次性认领后转交原设备；响应未知不重复交换授权码，需重新发起授权。 */
export async function finishRemoteOAuth(state: string, cookie: string, actor: string, code: string, user?: Member, cancelled = false) {
  oauthCookie(state); const store = cloudStore(); const name = "oauth-" + state + ".json";
  const transactionData = await transaction(store, async () => {
    const encrypted = await store.read<string>(name); if (!encrypted) throw new AppError("OAUTH", "授权已失效，请重新连接。");
    const value = unseal<OAuth>(encrypted);
    if (value.used || value.expires < Date.now() || value.actor !== actor || value.browserHash !== createHash("sha256").update(cookie).digest("hex")) throw new AppError("OAUTH", "授权校验失败，请在原浏览器重新连接。");
    if (user) await authorizeAgent(user, value.target.agentId);
    value.used = true; await store.write(name, seal(value)); return value;
  }, "oauth.lock");
  try { if(!cancelled) await rpc(transactionData.target, actor, { kind: "oauth-finish", cookie: transactionData.cookie, state: transactionData.state, code }); }
  catch(e){const problem=problemFor(e,{target:transactionData.target,domain:"youtube",stage:"连接原频道"});throw new AppError(problem.code,problem.message,409,problem);}
  finally { await store.remove(name).catch(()=>{ /* 已消费标记阻止重放；清理失败不覆盖授权结果。 */ }); }
  return transactionData.target;
}
