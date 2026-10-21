/** 云端 OAuth 事务桥：浏览器 cookie 绑定成员及设备，令牌交换在 Agent 完成。 */
import type { Member } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { config } from "@/core/config";
import { seal, unseal } from "@/core/storage";
import { AppError, isAppError, problemFor } from "@/core/errors";
import { cloudStore, transaction } from "./store";
import { rpc } from "./tasks";
import type { Target } from "@/shared/remote";
import { authorizePublishingAccount, requirePublishingAccount, requirePublishingAccountsCapability, publishingReauthorizationEpoch, completePublishingReauthorization, cancelPublishingReauthorization, assertPublishingAuthorizationEpoch, requirePublishingAuthorizationCapability } from "./publishing-accounts";
import { releaseOAuthActivity } from "./oauth-activities";
import { agentStore } from "./agents";
type OAuth = { target: Target; accountId?: string; publishingReauthorizationEpoch?: string; authorizationGeneration?: string; activityId?: string; actor: string; browserHash: string; state: string; cookie: string; expires: number; used: boolean };
/** cookie 名包含随机事务标识，允许多台电脑同时发起独立授权。 */
export function oauthCookie(state: string) { if (!/^[a-f0-9]{64}$/.test(state)) throw new AppError("OAUTH", "授权回调无效。"); return "livepilot_cloud_oauth_" + state.slice(0, 16); }
/** IP 网站明确引导到本地授权，不跳转到注定失败的 Google 回调。 */
export async function beginRemoteOAuth(target: Target, actor: string, accountId?: string) {
  if (isIP(new URL(config().origin).hostname)) throw new AppError("OAUTH_DOMAIN", accountId ? "Google 不支持公网 IP 回调。请联系管理员为控制端配置域名，以连接独立发布账号。" : "Google 不支持公网 IP 回调。请先在直播电脑本地连接频道，再启动 Agent；以后配置域名可在此授权。");
  let authorizationGeneration: string | undefined;
  if (accountId) {
    await requirePublishingAccountsCapability(target.agentId); const account = await requirePublishingAccount(target.agentId, target.instanceId, accountId, undefined, false);
    await requirePublishingAuthorizationCapability(target.agentId, accountId);
    if ((await agentStore(target.agentId).read<string[]>("capabilities.json"))?.includes("publishing-auth-generation-v1")) authorizationGeneration = randomUUID();
    else if (account.status === "needs_reauthorization") throw new AppError("AGENT_VERSION", "请升级直播电脑的 Agent 后重新授权原发布频道。", 409);
  }
  const epoch = accountId ? await publishingReauthorizationEpoch(target.agentId, accountId, !!authorizationGeneration, true, authorizationGeneration) : undefined;
  const activityId = randomUUID();
  let result: { url: string; cookie: string };
  try { result = await rpc(target, actor, accountId ? { kind: "publishing-account-oauth-begin", accountId } : { kind: "oauth-begin" }, activityId); }
  catch (error) { if (accountId && isAppError(error) && error.code === "BUSY") await cancelPublishingReauthorization(target.agentId, accountId, epoch, authorizationGeneration); throw error; }
  const url = new URL(result.url); const agentState = url.searchParams.get("state") || "";
  if (url.searchParams.get("redirect_uri") !== config().redirectUri) throw new AppError("OAUTH_CONFIG", "Agent 的控制端地址与云端不一致，请检查配置。");
  const state = randomBytes(32).toString("hex"); const cookie = randomBytes(32).toString("hex");
  await cloudStore().write("oauth-" + state + ".json", seal({ target, ...(accountId ? { accountId, publishingReauthorizationEpoch: epoch, authorizationGeneration } : { activityId }), actor, browserHash: createHash("sha256").update(cookie).digest("hex"), state: agentState, cookie: result.cookie, expires: Date.now() + 600_000, used: false } satisfies OAuth));
  url.searchParams.set("state", state); return { url: url.toString(), state, cookie };
}
/** 回调只读取已经过浏览器凭据校验的安全路由，失败提示也回到原发布模块。 */
export async function remoteOAuthContext(state: string, cookie: string, actor: string) {
  oauthCookie(state); const encrypted = await cloudStore().read<string>("oauth-" + state + ".json"); if (!encrypted) throw new AppError("OAUTH", "授权事务已失效，请重新连接。");
  const value = unseal<OAuth>(encrypted);
  if (value.used || value.expires < Date.now() || value.actor !== actor || value.browserHash !== createHash("sha256").update(cookie).digest("hex")) throw new AppError("OAUTH", "授权校验失败，请在原浏览器重新连接。");
  return { ...value.target, ...(value.accountId ? { accountId: value.accountId } : {}) };
}
/** 一次性认领后转交原设备；响应未知不重复交换授权码，需重新发起授权。 */
export async function finishRemoteOAuth(state: string, cookie: string, actor: string, code: string, user?: Member, cancelled = false) {
  oauthCookie(state); const store = cloudStore(); const name = "oauth-" + state + ".json";
  const transactionData = await transaction(store, async () => {
    const encrypted = await store.read<string>(name); if (!encrypted) throw new AppError("OAUTH", "授权已失效，请重新连接。");
    const value = unseal<OAuth>(encrypted);
    if (value.used || value.expires < Date.now() || value.actor !== actor || value.browserHash !== createHash("sha256").update(cookie).digest("hex")) throw new AppError("OAUTH", "授权校验失败，请在原浏览器重新连接。");
    if (user) { await authorizeAgent(user, value.target.agentId); if (value.accountId) await authorizePublishingAccount(user, value.accountId); }
    value.used = true; await store.write(name, seal(value)); return value;
  }, "oauth.lock");
  try {
    if (transactionData.accountId) {
      const account = await requirePublishingAccount(transactionData.target.agentId, transactionData.target.instanceId, transactionData.accountId, undefined, false);
      if (!cancelled && transactionData.publishingReauthorizationEpoch) await assertPublishingAuthorizationEpoch(transactionData.target.agentId, account.id, transactionData.publishingReauthorizationEpoch);
      await rpc(transactionData.target, actor, { kind: "publishing-account-oauth-finish", accountId: account.id, cookie: transactionData.cookie, state: transactionData.state, code, cancelled, ...(transactionData.authorizationGeneration ? { authorizationGeneration: transactionData.authorizationGeneration, authorizationEpoch: transactionData.publishingReauthorizationEpoch } : {}), ...(account.channelId ? { expectedChannel: account.channelId } : {}) });
      if (cancelled) await cancelPublishingReauthorization(transactionData.target.agentId, account.id, transactionData.publishingReauthorizationEpoch, transactionData.authorizationGeneration);
      if (!cancelled && !await completePublishingReauthorization(transactionData.target.agentId, account.id, transactionData.publishingReauthorizationEpoch, transactionData.authorizationGeneration)) throw new AppError("OAUTH_SUPERSEDED", "此授权已被更新的连接或授权错误替代，请重新连接原频道。", 409);
    }
    else {
      if (!cancelled) await rpc(transactionData.target, actor, { kind: "oauth-finish", cookie: transactionData.cookie, state: transactionData.state, code });
      await releaseOAuthActivity(transactionData.target.agentId, transactionData.target.instanceId, transactionData.activityId, transactionData.cookie);
    }
  }
  catch(e){const problem=problemFor(e,{target:transactionData.target,domain:"youtube",stage:"连接原频道"});throw new AppError(problem.code,problem.message,409,problem);}
  finally { await store.remove(name).catch(()=>{ /* 已消费标记阻止重放；清理失败不覆盖授权结果。 */ }); }
  return { ...transactionData.target, ...(transactionData.accountId ? { accountId: transactionData.accountId } : {}) };
}
