/** 独立成员账号与可撤销服务端会话；密码和会话凭据不进入业务 DTO。 */
import "server-only";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { dataRoot } from "./config";
import { Store } from "./storage";
import { AppError } from "./errors";

export type Member = { username: string };
type Account = Member & { salt: string; hash: string; revision: string; disabled: boolean };
type Session = { username: string; revision: string; expires: number };
type AccessState = { users: Account[]; sessions: Record<string, Session>; attempts: Record<string, { count: number; until: number }> };
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
export async function login(username: string, password: string) {
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
    delete state.attempts[digest(username)];
    const token = randomBytes(32).toString("hex");
    state.sessions[digest(token)] = { username, revision: user.revision, expires: now + 12 * 60 * 60_000 };
    await store.write("access.json", state);
    return { token, user: { username } };
  }, "access.lock");
}
/** 每个业务请求检查磁盘会话及账号版本，禁用或重置立即生效。 */
export async function authenticate(request: Request): Promise<Member> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("AUTH", "请登录后继续。", 401);
  const state = await accessStore().read<AccessState>("access.json");
  const session = state?.sessions[digest(token)];
  const user = session && state?.users.find(u => u.username === session.username && !u.disabled && u.revision === session.revision);
  if (!session || session.expires <= Date.now() || !user) throw new AppError("AUTH", "登录已失效，请重新登录。", 401);
  return { username: user.username };
}
/** 退出仅撤销当前会话，不干预 B 上执行中的直播。 */
export async function logout(request: Request) {
  const store = accessStore();
  await store.exclusive(async () => {
    const state = await store.read<AccessState>("access.json");
    if (state) { delete state.sessions[digest(cookieValue(request, SESSION_COOKIE))]; await store.write("access.json", state); }
  }, "access.lock");
}
