/** 固定 Origin 的 HTTP 安全边界与统一错误响应。 */
import "server-only";
import { config } from "./config";
import { AppError, safeError, isAppError } from "./errors";
/** 只信任配置的 Host，写请求必须同源；不使用转发头推断可信地址。 */
export function guard(request: Request, mutation = false) {
  const c = config();
  if (request.headers.get("host") !== new URL(c.origin).host) throw new AppError("HOST", "请从配置的 LivePilot 地址访问。", 403);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (mutation && (origin !== c.origin || request.headers.get("x-livepilot") !== "1" || site === "cross-site")) throw new AppError("ORIGIN", "控制请求必须从 LivePilot 页面发起。", 403);
  if (!mutation && origin && origin !== c.origin) throw new AppError("ORIGIN", "不允许跨站读取状态。", 403);
}
/** 将已登记的安全错误转为 HTTP 响应，保留跨模块错误状态码。 */
export function failed(e: unknown) { return Response.json({ error: safeError(e) }, { status: isAppError(e) ? e.status : 500, headers: { "Cache-Control": "no-store" } }); }
