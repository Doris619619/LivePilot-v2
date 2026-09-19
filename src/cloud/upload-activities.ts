/** 对照设备确认结果清理上传维护阻塞；超时与失败本身均不能证明上传已经结束。 */
import { unseal } from "@/core/storage";
import type { TaskPayload } from "@/shared/remote";
import type { UploadStatus } from "@/shared/uploads";
import { agentStore } from "./agents";
import type { TaskRecord } from "./tasks";
export type MaintenanceState = { token?: string; activities: Record<string, number> };
const terminal = (r: TaskRecord) => ["succeeded", "failed", "interrupted", "expired"].includes(r.status);
/** 仅解析已由协议校验的加密上传目标，不用错误文本推断上传身份。 */
export function uploadId(record: TaskRecord) {
  if (!record.kind.startsWith("upload-")) return;
  const payload = unseal<TaskPayload>(record.payload);
  return "uploadId" in payload ? payload.uploadId : undefined;
}
/** 持 tasks.lock 调用；只有无在途任务且有新的终态证明，才移除对应阻塞。 */
export async function reconcileUploads(id: string, records: TaskRecord[]) {
  const store = agentStore(id); const state = await store.read<MaintenanceState>("maintenance.json"); if (!state) return;
  const keys = Object.keys(state.activities).filter(k => k.startsWith("upload:"));
  if (!keys.length) return;
  const groups = new Map<string, TaskRecord[]>();
  for (const record of records) { const id = uploadId(record); if (id) groups.set(id, [...(groups.get(id) || []), record]); }
  let changed = false;
  for (const key of keys) {
    const related = groups.get(key.slice(7)) || [];
    if (!related.length || related.some(r => !terminal(r))) continue;
    const mutations = related.filter(r => r.kind !== "upload-status");
    const lastMutation = Math.max(0, ...mutations.map(r => r.updatedAt));
    const confirmed = related.some(r => {
      if (r.updatedAt < lastMutation) return false;
      // 查询开始时仍有写入或查询后又入队写入，迟到快照不能作为结束证明。
      if (r.kind === "upload-status" && (r.uploadStable !== true || r.createdAt < lastMutation || mutations.some(m => records.indexOf(m) > records.indexOf(r)))) return false;
      if (r.status === "succeeded" && r.kind === "upload-cancel") return related.some(c => c.actor === r.actor && c.instanceId === r.instanceId && (c.kind === "upload-create" || (c.kind === "upload-status" && c.status === "succeeded")));
      if (r.status === "succeeded" && r.result && ["upload-status", "upload-finish"].includes(r.kind)) return unseal<UploadStatus>(r.result).status === "complete";
      // 旧 Agent 的 404 可能也是账号不匹配；只核对创建人的同一实例与 ID。
      return r.kind === "upload-status" && r.status === "failed" && [404, 410].includes(r.httpStatus || 0) && related.some(c => c.kind === "upload-create" && c.actor === r.actor && c.instanceId === r.instanceId);
    });
    const neverDelivered = mutations.length > 0 && mutations.every(r => r.kind === "upload-create" && r.status === "expired");
    if (confirmed || neverDelivered) { delete state.activities[key]; changed = true; }
  }
  if (changed) await store.write("maintenance.json", state);
}
