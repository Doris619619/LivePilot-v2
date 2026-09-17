/** 逐片计算文件身份与上传；始终采用服务器确认的偏移，内存使用与文件大小无关。 */
"use client";
import { api } from "./client-request";
import type { UploadStatus } from "@/shared/uploads";
const CHUNK = 8 * 1024 * 1024;
/** 只处理单个分片或短哈希清单，不把整个文件读入内存。 */
async function sha(data: ArrayBuffer) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map(v => v.toString(16).padStart(2, "0")).join(""); }
/** 中断在分片边界检查，避免取消后继续发新请求。 */
function check(signal: AbortSignal) { if (signal.aborted) throw new Error("上传已暂停。重新选择同一文件可继续。"); }
/** 完整文件身份是各分片哈希的 SHA-256，服务端发布前使用相同规则校验。 */
export async function identify(file: File, signal: AbortSignal) {
  const hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK) { check(signal); hashes.push(await sha(await file.slice(offset, offset + CHUNK).arrayBuffer())); }
  check(signal);
  return { fingerprint: await sha(new TextEncoder().encode(hashes.join("")).buffer), hashes };
}
/** API 路径包含实例，服务器再次核对记录归属。 */
export function uploadUrl(record: UploadStatus, complete = false) { return "/api/uploads/" + record.id + (complete ? "/complete" : "") + "?instanceId=" + encodeURIComponent(record.instanceId); }
/** 上传或续传；不重试控制命令，仅允许幂等分片重传。 */
export async function transfer(file: File, record: UploadStatus, hashes: string[], signal: AbortSignal, update: (status: UploadStatus) => void) {
  let current = record;
  while (current.received < current.size) {
    check(signal); const offset = current.received; let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      check(signal);
      try {
        current = await api<UploadStatus>(uploadUrl(current), { method: "PUT", signal, headers: { "content-type": "application/octet-stream", "x-livepilot": "1", "upload-offset": String(offset), "upload-sha256": hashes[offset / CHUNK] }, body: file.slice(offset, offset + CHUNK) });
        sent = true; update(current);
      } catch (e) {
        check(signal); if (attempt === 2) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        current = await api<UploadStatus>(uploadUrl(current), { signal }); update(current);
        if (current.received > offset) sent = true;
      }
    }
  }
  check(signal);
  current = await api<UploadStatus>(uploadUrl(current, true), { method: "POST", signal, headers: { "x-livepilot": "1" } }); update(current);
  return current;
}
