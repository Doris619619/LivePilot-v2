/** 浏览器请求区分读取、写入、取消和账号认证；超时不重放操作。 */
"use client";
import { makeProblem, problemSchema, type Problem } from "../shared/problems";
let expectedMember: string | undefined;
/** 页面绑定当前成员；切换后旧标签页请求不得误用新账号执行控制。 */
export function setRequestMember(username?: string) { expectedMember = username; }
export class RequestError extends Error {
  /** 公开问题来自校验后的服务响应或本地固定说明。 */
  constructor(public problem: Problem, public status?: number) { super(problem.message); }
}
/** 可供就地错误卡使用，普通异常不透出原始对象内容。 */
export function requestProblem(error: unknown) { return error instanceof RequestError ? error.problem : makeProblem("UNKNOWN", "当前步骤未确认，请刷新原对象状态后核对。"); }
/** 响应格式异常仍先判断认证状态；业务凭据错误不会注销客户会话。 */
export async function api<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...options } = init || {};
  const read = !options.method || options.method === "GET";
  const rpc = /\/api\/(uploads|youtube|status)/.test(url);
  const ms = timeoutMs ?? (options.method === "PUT" && url.startsWith("/api/uploads") ? 120_000 : rpc ? 60_000 : read ? 15_000 : 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  let response: Response;
  const headers = new Headers(options.headers); if (expectedMember && !url.startsWith("/api/session")) headers.set("x-livepilot-user", expectedMember);
  try { response = await fetch(url, { ...options, headers, signal, cache:"no-store" }); }
  catch {
    const cancelled = options.signal?.aborted && options.signal.reason?.name !== "TimeoutError";
    throw new RequestError(makeProblem(cancelled ? "CANCELLED" : "CLOUD_NETWORK", cancelled ? "本次等待已取消；已发送操作仍需查询结果。" : read ? "暂时无法读取状态，请检查连接后重新查询。" : "请求结果尚未确认，请查询原操作，避免重复执行。", {source:"browser",outcome:read ? "rejected" : "unknown"}));
  }
  const data = await response.json().catch(()=>null);
  const parsed = problemSchema.safeParse(data?.problem);
  const customerAuth = response.status === 401 && (!parsed.success || parsed.data.code === "AUTH" || parsed.data.code === "LOGIN");
  if (customerAuth && url !== "/api/session") window.dispatchEvent(new Event("livepilot-login-required"));
  // 即使浏览器禁用存储通知，旧标签页被拒绝后也能重载当前身份；绝不重放原控制操作。
  if (response.status === 409 && parsed.success && parsed.data.code === "ACCOUNT_CHANGED") window.dispatchEvent(new Event("livepilot-account-changed"));
  if (!response.ok || !data) {
    const fallback = makeProblem(customerAuth ? "AUTH" : "CLOUD_UNAVAILABLE", customerAuth ? "登录已失效，请重新登录。" : typeof data?.error === "string" ? data.error : "服务暂未返回有效响应，请稍后查询原对象状态。", {source:"browser",outcome:read || response.status < 500 ? "rejected" : "unknown"});
    throw new RequestError(parsed.success ? parsed.data : fallback, response.status);
  }
  return data as T;
}
