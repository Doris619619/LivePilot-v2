/** 仅驻内存的出站预览中转：最多 64 个待请求，每次最多 1 MiB，绝不写任务或媒体文件。 */
import { randomUUID } from "node:crypto";
import { AppError } from "@/core/errors";
import { PREVIEW_CHUNK, type PreviewCommand } from "@/shared/media-preview";
type Reply = { bytes: Uint8Array; json: boolean };
type Pending = { command: PreviewCommand; delivered: boolean; receiving?: boolean; abortRead?: () => void; resolve(value: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const globalRelay = globalThis as typeof globalThis & { previewRelay?: Map<string, Pending> };
const pending: Map<string, Pending> = globalRelay.previewRelay ||= new Map<string, Pending>();
/** 浏览器请求只创建短期邮箱；断开或超时立即释放，不进入持久任务队列。 */
export function requestPreview(command: Omit<PreviewCommand, "id">, signal?: AbortSignal): Promise<Reply> {
  if (pending.size >= 64 || [...pending.values()].filter(p => p.command.target.agentId === command.target.agentId).length >= 12) throw new AppError("PREVIEW_BUSY", "预览请求较多，请稍后重试。", 429);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error, value?: Reply) => { const item = pending.get(id); if (!item) return; clearTimeout(item.timer); pending.delete(id); signal?.removeEventListener("abort", abort); if (error) { item.abortRead?.(); reject(error); } else resolve(value!); };
    const abort = () => finish(new AppError("PREVIEW_CANCELLED", "预览已关闭。", 499));
    pending.set(id, { command: { ...command, id }, delivered: false, resolve: value => finish(undefined, value), reject: error => finish(error), timer: setTimeout(() => finish(new AppError("AGENT_OFFLINE", "设备未响应预览，请检查连接后重试。", 503)), 25_000) });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}
/** 已认证 Agent 拉取自己的临时请求；批量上限限制本机瞬间负载。 */
export function pollPreview(agentId: string) { const items = [...pending.values()].filter(p => p.command.target.agentId === agentId && !p.delivered).slice(0, 4); for (const item of items) item.delivered = true; return items.map(p => p.command); }
/** 上传分片逐块计数，禁止无界 arrayBuffer；只接收对应设备的未过期邮箱。 */
export async function acceptPreview(agentId: string, id: string, request: Request) {
  const item = pending.get(id);
  if (!item || item.command.target.agentId !== agentId || !item.delivered) throw new AppError("PREVIEW_EXPIRED", "预览请求已失效。", 410);
  if (item.receiving) throw new AppError("PREVIEW_RESPONSE", "该分片正在接收。", 409);
  const json = request.headers.get("content-type") === "application/json";
  const limit = json ? 64 * 1024 : PREVIEW_CHUNK;
  const reader = request.body?.getReader(); if (!reader) throw new AppError("INPUT", "预览响应为空。");
  item.receiving = true; item.abortRead = () => { void reader.cancel().catch(() => {}); };
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > limit) throw new AppError("SIZE", "预览分片超过限制。", 413); chunks.push(result.value); } }
  catch (error) { await reader.cancel().catch(() => {}); item.reject(new AppError("PREVIEW_RESPONSE", "设备预览响应失败。", 502)); throw error; }
  finally { item.abortRead = undefined; reader.releaseLock(); }
  if (!pending.has(id)) throw new AppError("PREVIEW_EXPIRED", "预览请求已失效。", 410);
  const bytes = new Uint8Array(size); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  item.resolve({ bytes, json });
}
