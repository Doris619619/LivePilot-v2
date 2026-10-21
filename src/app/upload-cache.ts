/** 已认证成员的逐上传缓存；每个 ID 独立写入，多标签和换账号不能覆盖其他未知句柄。 */
import { uploadStatusSchema } from "@/shared/remote-validation";
import { z } from "zod";
import { readUploadIntent, type UploadIntent } from "./upload-intent";
import type { UploadStatus } from "@/shared/uploads";
const PREFIX = "livepilot-upload.v2:", LEGACY = "livepilot-upload";
const recordSchema = uploadStatusSchema.extend({ agentId: z.string().optional() });
export type CachedUpload = { id: string; intent?: UploadIntent; record?: UploadStatus; updatedAt: number };
/** 身份来自已认证工作区，不以 localStorage 中的归属声明切换成员。 */
function prefix(member: string) { return PREFIX + encodeURIComponent(member) + ":"; }
/** 写入后重读确认，记录落盘失败时调用方必须继续保留旧意图。 */
export function saveUploadCache(member: string, type: "intent" | "record", value: UploadIntent | UploadStatus) {
  const id = "requestId" in value ? value.requestId : value.id;
  const key = prefix(member) + id + ":" + type, serialized = JSON.stringify({ member, updatedAt: Date.now(), value });
  localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error("上传恢复句柄暂无法缓存，尚未发送新的创建请求。");
}
/** 只删除当前成员与当前 ID；取消一个会话不能删除另一标签的恢复身份。 */
export function removeUploadCache(member: string, id: string, type?: "intent" | "record") {
  for (const kind of type ? [type] : ["intent", "record"]) localStorage.removeItem(prefix(member) + id + ":" + kind);
}
/** 仅从当前成员命名空间读取；损坏条目原样保留，不迁入其他成员。 */
export function readUploadCache(member: string): CachedUpload[] {
  const items = new Map<string, CachedUpload>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (!key?.startsWith(prefix(member))) continue;
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null"); if (raw?.member !== member) continue;
      const type = key.endsWith(":intent") ? "intent" : key.endsWith(":record") ? "record" : undefined; if (!type) continue;
      const value = type === "intent" ? readUploadIntent(raw.value) : recordSchema.parse(raw.value), id = "requestId" in value ? value.requestId : value.id;
      if (key !== prefix(member) + id + ":" + type) continue;
      const item = items.get(id) || { id, updatedAt: 0 }; Object.assign(item, { [type]: value, updatedAt: Math.max(item.updatedAt, raw.updatedAt || 0) }); items.set(id, item);
    } catch { /* 保留坏缓存供人工核对，不覆盖原键。 */ }
  }
  return [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
/** 无归属旧版缓存只列为待核对候选；成功的原账号状态查询才可迁入成员缓存。 */
export function legacyUploadCache(): CachedUpload[] {
  const items = new Map<string, CachedUpload>();
  for (const type of ["intent", "record"] as const) {
    try {
      const raw = localStorage.getItem(LEGACY + (type === "intent" ? ".intent" : "")); if (!raw) continue;
      const value = type === "intent" ? readUploadIntent(JSON.parse(raw)) : recordSchema.parse(JSON.parse(raw)), id = "requestId" in value ? value.requestId : value.id;
      const item = items.get(id) || { id, updatedAt: 0 }; Object.assign(item, { [type]: value }); items.set(id, item);
    } catch { /* 未知旧句柄不删除，也不自动归当前成员。 */ }
  }
  return [...items.values()];
}
