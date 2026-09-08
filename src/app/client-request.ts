/** 浏览器请求统一处理会话失效与非 JSON 网络错误。 */
"use client";
/** API 401 交由入口显示登录页；不自动重放写请求。 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store" }); }
  catch { throw new Error("连接中断，结果待确认。请重新连接后核对状态。"); }
  let data;
  try { data = await response.json(); } catch { throw new Error("服务响应中断，结果待确认。请重新连接后核对状态。"); }
  if (response.status === 401 && url !== "/api/session") window.dispatchEvent(new Event("livepilot-login-required"));
  if (!response.ok) throw Object.assign(new Error(data.error || "请求未完成，请核对状态后重试。"), { status: response.status });
  return data as T;
}
