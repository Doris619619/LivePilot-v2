import "server-only";
import { config } from "./config";
import { AppError, safeError } from "./errors";
export function guard(request: Request, mutation = false) {
  const c = config();
  if (request.headers.get("host") !== new URL(c.origin).host) throw new AppError("HOST", "请从配置的 127.0.0.1 地址打开 LivePilot。", 403);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (mutation && (origin !== c.origin || request.headers.get("x-livepilot") !== "1" || site === "cross-site")) throw new AppError("ORIGIN", "控制请求必须从 LivePilot 本机页面发起。", 403);
  if (!mutation && origin && origin !== c.origin) throw new AppError("ORIGIN", "不允许跨站读取本机状态。", 403);
}
export function failed(e: unknown) { return Response.json({ error: safeError(e) }, { status: e instanceof AppError ? e.status : 500, headers: { "Cache-Control": "no-store" } }); }
