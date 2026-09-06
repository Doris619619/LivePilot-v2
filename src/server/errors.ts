import "server-only";
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function safeError(error: unknown): string {
  return error instanceof AppError ? error.message : "操作失败。请检查本机配置、网络和服务状态后重试；没有继续执行后续步骤。";
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function waitFor<T>(read: () => Promise<T>, accept: (v: T) => boolean, message: string, timeout = 120_000, interval = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await sleep(interval);
  } while (Date.now() < deadline);
  throw new AppError("TIMEOUT", message, 504);
}
