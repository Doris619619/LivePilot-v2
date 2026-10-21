/** 浏览器上传创建意图的严格恢复句柄；未知回执必须保留原设备、素材类型和幂等ID。 */
import { z } from "zod";
import type { UploadStatus } from "@/shared/uploads";
const name = /^[a-z][a-z0-9_]{0,31}$/;
const schema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), target: z.string().refine(value => { const parts = value.split(":"); return parts.length >= 1 && parts.length <= 2 && parts.every(part => name.test(part)); }), kind: z.enum(["videos", "music"]), requestId: z.string().uuid() }).strict();
export type UploadIntent = z.infer<typeof schema>;
/** 只接受产品曾写入的完整句柄；损坏缓存不能被当作没有待确认创建。 */
export function readUploadIntent(value: unknown): UploadIntent { return schema.parse(value); }
/** 不依赖当前实例清单解析原句柄，目标离线或移除后仍可向原设备查询及请求取消。 */
export function uploadIntentHandle(intent: UploadIntent) {
  const parts = intent.target.split(":");
  return { id: intent.requestId, instanceId: parts.at(-1)!, ...(parts.length === 2 ? { agentId: parts[0] } : {}) };
}
/** 同一ID也必须匹配原设备、类型与文件身份，不能把异常服务响应当成原创建的恢复结果。 */
export function assertUploadIntent(intent: UploadIntent, next: UploadStatus) {
  const handle = uploadIntentHandle(intent);
  if (handle.id !== next.id || handle.instanceId !== next.instanceId || handle.agentId !== next.agentId || intent.kind !== next.kind || intent.fingerprint !== next.fingerprint) throw new Error("上传记录与原创建意图不一致，请在原电脑核对，当前恢复句柄已保留。");
}
