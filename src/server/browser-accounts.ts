/** 浏览器已登录账号切换；账号凭据仅存 HttpOnly Cookie，清单只公开已验证的成员名称。 */
import "server-only";
import { NextResponse } from "next/server";
import { cookieValue, SESSION_COOKIE, webSession, type Member } from "./access";
import { config } from "./config";
import { AppError } from "./errors";
export const BROWSER_ACCOUNT_LIMIT = 6;
export const BROWSER_ACCOUNTS_COOKIE = "livepilot_accounts";
/** 单个 HttpOnly Cookie 一次保存完整组合，并发登录最后一份响应仍最多六项。 */
export function accountTokens(tokens: string[]) { return Buffer.from(JSON.stringify(tokens)).toString("base64url"); }
/** 每次使用保存的会话重新验证账户版本和有效期；旧活动 Cookie 可直接加入清单。 */
export async function rememberedAccounts(request: Request) {
  const tokens = new Map<string, { token: string; user: Member; expires: number }>();
  const active = cookieValue(request, SESSION_COOKIE);
  let saved: unknown;
  try { saved = JSON.parse(Buffer.from(cookieValue(request, BROWSER_ACCOUNTS_COOKIE), "base64url").toString("utf8")); } catch { /* 缺失或损坏列表不影响现有活动会话。 */ }
  const candidates = Array.isArray(saved) && saved.length <= 32 && saved.every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ? saved as string[] : [];
  for (const token of [...candidates, active]) {
    const session = await webSession(token);
    if (session) tokens.set(session.user.username, { token, ...session });
  }
  return { values: [...tokens.values()], active };
}
/** 只公开账号及当前身份；Cookie 中的 Token 永不进入响应 DTO。 */
export async function browserAccountView(request: Request) {
  const remembered = await rememberedAccounts(request);
  return { accounts: remembered.values.map(value => ({ ...value.user, current: value.token === remembered.active })) };
}
/** 统一安全 Cookie；保留原会话到期时刻，切换不续期。 */
export function setAccountSession(response: NextResponse, name: string, token: string, expires: number) {
  response.cookies.set(name, token, { httpOnly: true, secure: config().origin.startsWith("https:"), sameSite: "lax", path: "/", maxAge: Math.max(0, Math.floor((expires - Date.now()) / 1000)) });
}
/** 登录后保留旧账号，再激活新账号；每个浏览器最多六个有效账号，不保存密码。 */
export async function rememberLogin(request: Request, response: NextResponse, result: { token: string; user: Member; expires: number }) {
  const remembered = await rememberedAccounts(request);
  const values = [...remembered.values.filter(value => value.user.username !== result.user.username).slice(-(BROWSER_ACCOUNT_LIMIT - 1)), result];
  setAccountSession(response, BROWSER_ACCOUNTS_COOKIE, accountTokens(values.map(value => value.token)), Math.max(...values.map(value => value.expires)));
  setAccountSession(response, SESSION_COOKIE, result.token, result.expires);
}
/** 只能激活本浏览器已登录、仍有效的账号；知道账号名不能切换到它。 */
export async function switchBrowserAccount(request: Request, username: string) {
  const { values } = await rememberedAccounts(request); const selected = values.find(value => value.user.username === username);
  if (!selected) throw new AppError("ACCOUNT_SESSION", "这个账号的登录已失效，请重新添加。", 409);
  const response = NextResponse.json({ user: selected.user }, { headers: { "Cache-Control": "no-store" } });
  setAccountSession(response, BROWSER_ACCOUNTS_COOKIE, accountTokens(values.map(value => value.token)), Math.max(...values.map(value => value.expires)));
  setAccountSession(response, SESSION_COOKIE, selected.token, selected.expires); return response;
}
/** 退出时从组合中删除当前成员；其余成员的会话与原有效期保留。 */
export async function forgetActiveAccount(request: Request, response: NextResponse, username?: string) {
  const remembered = await rememberedAccounts(request); const values = remembered.values.filter(value => value.user.username !== username);
  setAccountSession(response, BROWSER_ACCOUNTS_COOKIE, values.length ? accountTokens(values.map(value => value.token)) : "", values.length ? Math.max(...values.map(value => value.expires)) : 0);
}
