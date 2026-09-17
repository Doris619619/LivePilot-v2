/** 有界分片中转：最多两个 8 MiB 文件，Agent 落盘确认才返回上传进度。 */
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink, statfs } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { cloudStore, transaction } from "./store";
import { requireTarget } from "./agents";
import { rpc } from "./tasks";
import { AppError, sleep } from "@/core/errors";
import type { Target } from "@/shared/remote";
import type { UploadStatus } from "@/shared/uploads";
const CHUNK = 8 * 1024 ** 2;
type Slot = Target & { id: string; actor: string; expires: number; ready: boolean; size: number };
/** 中转路径只接受服务端生成 UUID，不使用用户文件名。 */
function location(id: string) { return path.join(cloudStore().dir, "relay", id + ".part"); }
/** 回收本功能自有分片；不递归删除，不触碰用户媒体。 */
export async function releaseSlot(id: string) {
  const store = cloudStore(); await transaction(store, async () => {
    const slots = await store.read<Slot[]>("relay.json") || [];
    if (!slots.some(s => s.id === id)) return;
    try { await unlink(location(id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await store.write("relay.json", slots.filter(s => s.id !== id));
  }, "relay.lock");
}
/** 对所有设备一起限制容量；满时等待，不能绕过限制无限写文件。 */
async function reserve(target: Target, actor: string, signal: AbortSignal): Promise<Slot> {
  const store = cloudStore(); const deadline = Date.now() + 45_000;
  await mkdir(path.join(store.dir, "relay"), { recursive: true, mode: 0o700 });
  do {
    if (signal.aborted) throw new AppError("UPLOAD", "上传已暂停。");
    const slot = await transaction(store, async () => {
      let slots = await store.read<Slot[]>("relay.json") || [];
      for (const old of slots.filter(s => s.expires < Date.now())) { try { await unlink(location(old.id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
      slots = slots.filter(s => s.expires >= Date.now());
      if (slots.length >= 2) { await store.write("relay.json", slots); return; }
      const disk = await statfs(store.dir);
      if (disk.bavail * disk.bsize < (slots.length + 1) * CHUNK + 512 * 1024 ** 2) throw new AppError("SPACE", "云端磁盘余量不足，请先检查服务器；目标素材保持不变。", 507);
      const next: Slot = { ...target, id: randomUUID(), actor, expires: Date.now() + 600_000, ready: false, size: 0 };
      slots.push(next); await store.write("relay.json", slots); return next;
    }, "relay.lock");
    if (slot) return slot; await sleep(250);
  } while (Date.now() < deadline);
  throw new AppError("RELAY_BUSY", "其他素材正在传输，请稍后继续；已有进度保留。", 503);
}
/** 逐段落盘，最大 8 MiB；浏览器中断只影响这个分片。 */
async function spool(slot: Slot, request: Request, expected: number) {
  const file = await open(location(slot.id), "wx", 0o600); const reader = request.body?.getReader(); let size = 0;
  try {
    if (!reader) throw new AppError("UPLOAD", "分片为空。");
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      if (size + value.byteLength > expected) throw new AppError("SIZE", "分片超过允许大小。", 413);
      let written = 0; while (written < value.length) { const result = await file.write(value, written, value.length - written, size + written); written += result.bytesWritten; }
      size += value.length;
    }
    if (size !== expected) throw new AppError("SIZE", "分片不完整，请继续上传。", 409);
    await file.sync();
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); await file.close(); }
  const store = cloudStore(); await transaction(store, async () => {
    const slots = await store.read<Slot[]>("relay.json") || []; const current = slots.find(s => s.id === slot.id);
    if (!current) throw new AppError("UPLOAD", "分片中转已过期，请重试。", 409);
    current.ready = true; current.size = size; await store.write("relay.json", slots);
  }, "relay.lock");
}
/** 先向目标核对上传归属及偏移，再发送有界分片；响应丢失可用原偏移续传。 */
export async function relayChunk(target: Target, actor: string, uploadId: string, offset: number, hash: string, request: Request) {
  await requireTarget(target.agentId, target.instanceId, true);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError("OFFSET", "分片参数无效。", 409);
  const status = await rpc<UploadStatus>(target, actor, { kind: "upload-status", uploadId });
  if (offset >= status.size || offset > status.received || status.status !== "uploading") throw new AppError("OFFSET", "上传进度已变化，请刷新后继续。", 409);
  const expected = Math.min(CHUNK, status.size - offset);
  if (Number(request.headers.get("content-length") || 0) > expected) throw new AppError("SIZE", "分片超过允许大小。", 413);
  const slot = await reserve(target, actor, request.signal); let dispatched = false;
  try {
    await spool(slot, request, expected); dispatched = true;
    const result = await rpc<UploadStatus>(target, actor, { kind: "upload-chunk", uploadId, offset, hash, slot: slot.id, size: expected });
    await releaseSlot(slot.id); return { ...result, agentId: target.agentId };
  } catch (error) {
    // 已派发的分片保留供正在下载的 Agent；短期租约到期后自动回收。
    if (!dispatched) await releaseSlot(slot.id); throw error;
  }
}
/** 仅绑定的设备能下载已完成暂存的分片；不暴露文件系统路径。 */
export async function downloadSlot(agentId: string, id: string) {
  const slot = (await cloudStore().read<Slot[]>("relay.json"))?.find(s => s.id === id && s.agentId === agentId && s.ready && s.expires > Date.now());
  if (!slot) throw new AppError("UPLOAD", "分片不存在或已过期。", 404);
  const stream = Readable.toWeb(createReadStream(location(id)));
  return new Response(stream as ReadableStream, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(slot.size), "Cache-Control": "no-store" } });
}
