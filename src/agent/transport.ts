/** Agent 仅主动访问一个固定 HTTPS 控制端，不接受远程任意 URL。 */
import { AppError } from "@/core/errors";
/** 生产固定 HTTPS，测试只允许显式 loopback HTTP。 */
export function controllerOrigin(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new AppError("CONFIG", "请配置有效的 LIVEPILOT_ORIGIN。"); }
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new AppError("CONFIG", "Agent 必须连接固定 HTTPS 控制端。");
  return url.origin;
}
export class Transport {
  session = "";
  /** 凭据来自本机文件，只送入固定控制端 Authorization。 */
  constructor(readonly origin: string, readonly agentId: string, private token: string) { controllerOrigin(origin); }
  /** 每个请求有超时，不跟随重定向以免发送设备凭据到其他地址。 */
  async request(route: string, init: RequestInit = {}, timeout = 30_000) {
    if (!route.startsWith("/api/agent/")) throw new AppError("PROTOCOL", "设备请求路径无效。");
    const headers = new Headers(init.headers); headers.set("authorization", "Bearer " + this.token); headers.set("x-livepilot-agent", this.agentId); if (this.session) headers.set("x-livepilot-session", this.session);
    let response: Response;
    try { response = await fetch(this.origin + route, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(timeout), cache: "no-store" }); }
    catch { throw new AppError("CLOUD_NETWORK", "暂时无法连接控制端，任务和素材进度保留。", 503); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status === 401 ? "AGENT_AUTH" : "CLOUD_REQUEST", response.status === 401 ? "设备凭据失效，请检查是否已撤销。" : "控制端尚未确认设备请求，请检查配置或稍后重连。", response.status); }
    return response;
  }
  /** JSON 数据限于协议消息，素材本体使用独立二进制分片请求。 */
  async post<T>(route: string, data: unknown): Promise<T> { return (await this.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json() as Promise<T>; }
}
