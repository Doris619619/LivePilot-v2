/** 仅暴露应用主动构造的安全错误；跨路由及开发热更新保留可信身份，不按对象形状信任上游错误。 */
import { makeProblem, type Problem, type ProblemMeta } from "../shared/problems";
const registry = globalThis as typeof globalThis & { livePilotSafeErrors?: WeakSet<object> };
const trusted = registry.livePilotSafeErrors ??= new WeakSet<object>();
export class AppError extends Error {
  /** 将本应用构造的错误登记为可信；原始上游异常不得直接传入 message。 */
  constructor(public code: string, message: string, public status = 400, public problem?: Problem) { super(message); trusted.add(this); }
}
/** WeakSet 跨模块重载共享身份；伪造 code/message 字段无法通过检查。 */
export function isAppError(error: unknown): error is AppError {
  return typeof error === "object" && error !== null && trusted.has(error);
}
/** 只显示可信应用错误，未知异常始终返回固定文本。 */
export function safeError(error: unknown): string {
  return problemFor(error).message;
}
/** 系统异常只识别 errno 白名单；未登记的 message、路径和上游正文永不回显。 */
export function problemFor(error: unknown, meta: ProblemMeta = {}): Problem {
  meta = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  if (isAppError(error)) return error.problem ? { ...error.problem, ...meta, target: { ...error.problem.target, ...Object.fromEntries(Object.entries(meta.target || {}).filter(([, value]) => value !== undefined)) } } : makeProblem(error.code, error.message, meta);
  const code = (error as { code?: unknown } | null)?.code;
  const known: Record<string, [string, string]> = { EACCES:["STORAGE_PERMISSION","数据访问被拒绝，请在原电脑检查目录权限。"], EPERM:["STORAGE_PERMISSION","数据访问被拒绝，请使用原 Windows 账户检查权限。"], ENOSPC:["STORAGE_SPACE","磁盘空间不足，请检查对应数据盘。"], ENOENT:["STORAGE_MISSING","所需文件暂不可访问，请检查原数据盘和目录。"] };
  const [name, message] = typeof code === "string" && known[code] || ["UNKNOWN", "当前步骤未完成，执行结果需要核对。请先刷新状态，仍失败时复制诊断摘要联系管理员。"];
  return makeProblem(name, message, meta);
}
/** 让轮询在真实请求之间等待，不生成模拟进度。 */
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** 在时限内读取并确认真实状态，未确认时给出调用方提供的安全错误。 */
export async function waitFor<T>(read: () => Promise<T>, accept: (v: T) => boolean, message: string, timeout = 120_000, interval = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await sleep(interval);
  } while (Date.now() < deadline);
  throw new AppError("TIMEOUT", message, 504);
}
