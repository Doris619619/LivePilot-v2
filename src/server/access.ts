/** 独立成员账号与可撤销服务端会话；密码和会话凭据不进入业务 DTO。 */
import "server-only";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { dataRoot } from "./config";
import { Store } from "./storage";
import { AppError } from "./errors";

export type Member = { username: string; role: "admin" | "customer" };
type Account = Omit<Member, "role"> & { role?: Member["role"] } & { salt: string; hash: string; revision: string; disabled: boolean };
type Session = { username: string; revision: string; expires: number; desktop?: boolean };
type AccessState = { users: Account[]; sessions: Record<string, Session>; attempts: Record<string, { count: number; until: number }>; accountEvents?: { actor: string; username: string; action: string; at: number }[] };
export const SESSION_COOKIE = "livepilot_session";
/** 共享账户不属于任何 OBS，单独存放以保留既有实例授权。 */
export function accessStore() { return new Store(path.resolve(/* turbopackIgnore: true */ process.env.LIVEPILOT_ACCESS_DIR || path.join(dataRoot(), "access"))); }
/** 固定格式便于本机管理命令与服务端互操作。 */
export function emptyAccess(): AccessState { return { users: [], sessions: {}, attempts: {} }; }
/** 用不可逆摘要索引会话与限速记录。 */
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
/** 异步密码派生避免阻塞状态轮询；参数与管理脚本一致。 */
export function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
/** 从请求读取指定 Cookie；格式异常视为不存在。 */
export function cookieValue(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1) || "";
}
/** 校验凭据并原子创建会话；账户及总入口均有限速，不信任代理 IP。 */
export async function login(username: string, password: string, desktop = false) {
  const store = accessStore();
  return store.exclusive(async () => {
    const state = await store.read<AccessState>("access.json") || emptyAccess();
    const now = Date.now();
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, s]) => s.expires > now));
    state.attempts = Object.fromEntries(Object.entries(state.attempts).filter(([, a]) => a.until > now));
    const keys = ["global", digest(username)];
    if (keys.some((key, i) => (state.attempts[key]?.count || 0) >= (i ? 10 : 100))) throw new AppError("RATE", "登录尝试过多，请在 15 分钟后重试。", 429);
    for (const key of keys) {
      const entry = state.attempts[key] ||= { count: 0, until: now + 15 * 60_000 };
      entry.count++;
    }
    await store.write("access.json", state);
    const user = state.users.find(u => u.username === username && !u.disabled);
    const hash = await passwordHash(password, user?.salt || "0".repeat(32));
    if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, "hex"))) throw new AppError("LOGIN", "账号或密码不正确。", 401);
    const role = accountRole(user);
    if (desktop && role !== "customer") throw new AppError("ROLE", "管理员请使用管理员网页端。", 403);
    delete state.attempts[digest(username)];
    const token = randomBytes(32).toString("hex");
    state.sessions[digest(token)] = { username, revision: user.revision, expires: now + 12 * 60 * 60_000, desktop };
    await store.write("access.json", state);
    return { token, user: { username, role }, expires: now + 12 * 60 * 60_000 };
  }, "access.lock");
}
/** 每个业务请求检查磁盘会话及账号版本，禁用或重置立即生效。 */
export async function authenticate(request: Request, desktop = false): Promise<Member> {
  const token = desktop ? /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") || "")?.[1] || "" : cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("AUTH", "请登录后继续。", 401);
  const state = await accessStore().read<AccessState>("access.json");
  const session = state?.sessions[digest(token)];
  const user = session && state?.users.find(u => u.username === session.username && !u.disabled && u.revision === session.revision);
  if (!session || session.expires <= Date.now() || !user) throw new AppError("AUTH", "登录已失效，请重新登录。", 401);
  if (!!session.desktop !== desktop || (desktop && accountRole(user) !== "customer")) throw new AppError("AUTH", "请使用客户账号重新登录。", 401);
  const expected = request.headers.get("x-livepilot-user");
  if (!desktop && expected && expected !== user.username) throw new AppError("ACCOUNT_CHANGED", "账号已切换，请刷新页面后继续。", 409);
  return { username: user.username, role: accountRole(user) };
}
/** 仅验证已有网页会话；切换清单不延长有效期，桌面凭据不能用于网页登录。 */
export async function webSession(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  const state = await accessStore().read<AccessState>("access.json"); const session = state?.sessions[digest(token)];
  const user = session && state?.users.find(value => value.username === session.username && !value.disabled && value.revision === session.revision);
  if (!session || session.desktop || session.expires <= Date.now() || !user) return;
  return { user: { username: user.username, role: accountRole(user) }, expires: session.expires };
}
/** 退出仅撤销当前会话，不干预 B 上执行中的直播。 */
export async function logout(request: Request, desktop = false) {
  const store = accessStore();
  await store.exclusive(async () => {
    const state = await store.read<AccessState>("access.json");
    const token = desktop ? request.headers.get("authorization")?.replace(/^Bearer /, "") || "" : cookieValue(request, SESSION_COOKIE);
    if (state) { delete state.sessions[digest(token)]; await store.write("access.json", state); }
  }, "access.lock");
}

/** 大写 U 只是管理员命名约束；仍须由受控管理流程明确授予角色。 */
export function accountRole(user: { username: string; role?: string }): Member["role"] { return user.role === "admin" && user.username.startsWith("U") ? "admin" : "customer"; }
/** 管理员界面只读取公开账号信息。 */
export async function members(): Promise<Member[]> { const state = await accessStore().read<AccessState>("access.json"); return (state?.users || []).filter(u => !u.disabled).map(u => ({ username: u.username, role: accountRole(u) })); }
/** 服务端管理员入口统一拒绝客户。 */
export function requireAdmin(user: Member) { if (user.role !== "admin") throw new AppError("FORBIDDEN", "仅管理员可访问。", 403); }

/** 账号页只公开客户名称与启用状态，绝不返回密码摘要。 */
export async function customerAccounts() {
  const state = await accessStore().read<AccessState>("access.json");
  return (state?.users || []).filter(u => accountRole(u) === "customer").map(u => ({ username: u.username, disabled: u.disabled }));
}
/** 锁内重新验证操作者会话，密码、会话撤销和审计同一次原子提交。 */
export async function changeCustomer(request: Request, action: "create" | "reset", username: string, password: string) {
  if (!/^[A-Za-z0-9_]{2,32}$/.test(username)) throw new AppError("ACCOUNT_NAME", "账号须为 2–32 位字母、数字或下划线。", 400);
  if (action === "create" && username.startsWith("U")) throw new AppError("ACCOUNT_NAME", "大写 U 开头的账号保留给管理员。", 400);
  if (password.length < 8 || password.length > 256) throw new AppError("ACCOUNT_PASSWORD", "密码须为 8–256 位。", 400);
  const store = accessStore();
  return store.exclusive(async () => {
    const actor = await authenticate(request); requireAdmin(actor);
    const state = (await store.read<AccessState>("access.json"))!;
    const now = Date.now(); const key = "account-change-" + digest(actor.username);
    const limit = state.attempts[key];
    if (limit && limit.until > now && limit.count >= 30) throw new AppError("RATE", "账号操作过于频繁，请稍后再试。", 429);
    let user = state.users.find(u => u.username === username);
    if (action === "create" && user) throw new AppError("ACCOUNT_EXISTS", "此账号已存在，请使用其他名称。", 409);
    if (action === "reset" && !user) throw new AppError("ACCOUNT_MISSING", "客户账号不存在，请刷新列表。", 404);
    if (user && accountRole(user) !== "customer") throw new AppError("FORBIDDEN", "此入口只能管理客户账号。", 403);
    const salt = randomBytes(16).toString("hex"); const hash = (await passwordHash(password, salt)).toString("hex");
    if (!user) { user = { username, role: "customer", salt, hash, revision: "", disabled: false }; state.users.push(user); }
    Object.assign(user, { salt, hash, revision: randomBytes(16).toString("hex") });
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, s]) => s.username !== username));
    state.attempts[key] = { count: limit && limit.until > now ? limit.count + 1 : 1, until: limit && limit.until > now ? limit.until : now + 900_000 };
    delete state.attempts[digest(username)];
    (state.accountEvents ||= []).push({ actor: actor.username, username, action, at: now });
    await store.write("access.json", state);
    return { username: user.username, disabled: user.disabled };
  }, "access.lock");
}
