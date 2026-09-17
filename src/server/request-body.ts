/** 有界读取 HTTP 请求，拒绝超过限额的数据，防止大请求占满内存。 */
import "server-only";
import { AppError } from "./errors";
/** 累计实际字节数而非信任 Content-Length，并在溢出时取消流。 */
export async function readBounded(request: Request, limit: number) {
  if (Number(request.headers.get("content-length") || 0) > limit) throw new AppError("SIZE", "请求超过允许大小。", 413);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
      if (size > limit) { await reader.cancel(); throw new AppError("SIZE", "请求超过允许大小。", 413); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
/** JSON 路由统一检查类型、长度及语法。 */
export async function readJson(request: Request, limit = 4096): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INPUT", "请求必须是 JSON。");
  const body = await readBounded(request, limit);
  try { return JSON.parse(body.toString("utf8")); } catch { throw new AppError("INPUT", "JSON 格式无效。"); }
}
