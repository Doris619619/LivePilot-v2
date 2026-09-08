/** 每个实例独立保存 OAuth 事务和加密令牌；客户端密钥只在服务端交换。 */
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rename, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { store, Store, seal, unseal } from "../storage";
import { AppError } from "../errors";
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; channelId: string; channel: string };
type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number };
type Transaction = { actor?: string; instanceId: string; state: string; verifier: string; expiresAt: number };
/** 用 Cookie 摘要定位内部事务文件，不把随机 Cookie 直接用作路径。 */
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
/** 等长字节使用常量时间比较，避免 OAuth state 的逐字符比较。 */
export function same(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
/** 通过有超时的服务端请求交换或刷新 Token，并过滤上游诊断。 */
async function tokenRequest(body: Record<string, string>): Promise<TokenReply> {
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams(body), cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch { throw new AppError("GOOGLE_NETWORK", "无法连接 Google 授权服务。请检查本机服务的网络连接。"); }
  if (!response.ok) throw new AppError("GOOGLE_AUTH", "Google 授权失效或 OAuth 配置不匹配，请重新连接 YouTube。", 401);
  const data = await response.json() as TokenReply;
  if (!data.access_token) throw new AppError("GOOGLE_AUTH", "Google 未返回有效授权。请重新连接 YouTube。", 401);
  return data;
}
export class YouTubeAuth {
  private refreshing?: Promise<Tokens>;
  /** 使用实例专属目录；可注入跨实例频道归属校验及保存逻辑。 */
  constructor(private storage: Store = store(), private instanceId = "main", private saveBinding?: (tokens: Tokens) => Promise<void>) {}
  /** 令牌保存与刷新写入共用短锁，避免旧刷新覆盖新授权。 */
  private async save(tokens: Tokens) {
    await this.storage.exclusive(async () => {
      if (this.saveBinding) await this.saveBinding(tokens);
      else await this.storage.write("youtube.enc", seal(tokens));
    }, "tokens.lock");
  }
  /** 只解密所属实例的授权；缺文件表示该实例未连接。 */
  async tokens() {
    const value = await this.storage.read<string>("youtube.enc");
    return value ? unseal<Tokens>(value) : null;
  }
  /** 保存绑定操作者与实例的一次性 PKCE 事务和浏览器 Cookie。 */
  async begin(actor?: string) {
    const c = config();
    if (!c.clientId || !c.clientSecret) throw new AppError("CONFIG", "请先配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。");
    const cookie = randomBytes(32).toString("hex");
    const state = this.instanceId + "." + randomBytes(32).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    await this.storage.write("oauth-" + hash(cookie) + ".enc", seal({ actor, instanceId: this.instanceId, state, verifier, expiresAt: Date.now() + 600_000 }));
    return { cookie, url: "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube", access_type: "offline",
      prompt: "consent select_account", state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }) };
  }
  /** 原子认领事务后验证操作者、Cookie/state/实例，确认频道再保存新授权。 */
  async finish(cookie: string, state: string, code: string, expectedChannel?: string, actor?: string) {
    if (!/^[a-f0-9]{64}$/.test(cookie) || !state || !code) throw new AppError("OAUTH_STATE", "授权回调无效，请从本页面重新连接。");
    const filename = path.join(this.storage.dir, "oauth-" + hash(cookie) + ".enc");
    const claimed = filename + ".claimed";
    try { await rename(filename, claimed); } catch { throw new AppError("OAUTH_STATE", "授权已过期或已被使用，请重新连接。"); }
    let tx: Transaction;
    try { tx = unseal<Transaction>(JSON.parse(await readFile(claimed, "utf8"))); }
    finally { await unlink(claimed); }
    if (tx.actor !== actor || tx.instanceId !== this.instanceId || tx.expiresAt < Date.now() || !same(tx.state, state)) throw new AppError("OAUTH_STATE", "授权校验失败，请在发起授权的浏览器中重试。");
    const c = config();
    const reply = await tokenRequest({ client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code", code, code_verifier: tx.verifier });
    if (!reply.refresh_token) throw new AppError("GOOGLE_AUTH", "Google 没有返回离线授权。请在 Google 账号中撤销本应用授权后重新连接。");
    let response: Response;
    try { response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers: { Authorization: "Bearer " + reply.access_token }, signal: AbortSignal.timeout(20_000), cache: "no-store" }); }
    catch { throw new AppError("GOOGLE_NETWORK", "授权后无法读取 YouTube Channel，请检查网络并重新连接。"); }
    if (!response.ok) throw new AppError("YOUTUBE_CHANNEL", "无法读取 YouTube Channel。请启用 YouTube Data API v3 并检查授权。");
    const data = await response.json() as { items?: { id: string; snippet: { title: string } }[] };
    if (data.items?.length !== 1) throw new AppError("YOUTUBE_CHANNEL", "请授权一个明确的 YouTube Channel。");
    const channel = data.items[0];
    if (expectedChannel && channel.id !== expectedChannel) throw new AppError("CHANNEL", "当前有未结束场次，请重新授权原 Channel。");
    await this.save({ accessToken: reply.access_token!, refreshToken: reply.refresh_token, expiresAt: Date.now() + (reply.expires_in || 3600) * 1000, channelId: channel.id, channel: channel.snippet.title } satisfies Tokens);
  }
  /** 返回有效授权或去重刷新；写入时避免覆盖已更新的频道凭据。 */
  async access(): Promise<Tokens> {
    const tokens = await this.tokens();
    if (!tokens) throw new AppError("YOUTUBE_DISCONNECTED", "请先连接 YouTube。", 401);
    if (tokens.expiresAt > Date.now() + 60_000) return tokens;
    if (!this.refreshing) this.refreshing = (async () => {
      const c = config();
      const reply = await tokenRequest({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: tokens.refreshToken });
      const next = { ...tokens, accessToken: reply.access_token!, refreshToken: reply.refresh_token || tokens.refreshToken, expiresAt: Date.now() + (reply.expires_in || 3600) * 1000 };
      return this.storage.exclusive(async () => {
        const current = await this.tokens();
        if (current && (current.refreshToken !== tokens.refreshToken || current.channelId !== tokens.channelId || current.expiresAt > next.expiresAt)) return current;
        await this.storage.write("youtube.enc", seal(next));
        return next;
      }, "tokens.lock");
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
}
