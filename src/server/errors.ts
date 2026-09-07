/** 仅暴露应用主动构造的安全错误；跨路由及开发热更新保留可信身份，不按对象形状信任上游错误。 */
import "server-only";
const registry = globalThis as typeof globalThis & { livePilotSafeErrors?: WeakSet<object> };
const trusted = registry.livePilotSafeErrors ??= new WeakSet<object>();
export class AppError extends Error {
  /** 将本应用构造的错误登记为可信；原始上游异常不得直接传入 message。 */
  constructor(public code: string, message: string, public status = 400) { super(message); trusted.add(this); }
}
/** WeakSet 跨模块重载共享身份；伪造 code/message 字段无法通过检查。 */
export function isAppError(error: unknown): error is AppError {
  return typeof error === "object" && error !== null && trusted.has(error);
}
/** 只显示可信应用错误，未知异常始终返回固定文本。 */
export function safeError(error: unknown): string {
  return isAppError(error) ? error.message : "操作失败。请检查本机配置、网络和服务状态后重试；没有继续执行后续步骤。";
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
