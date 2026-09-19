/** 从云端持久任务恢复上传入口；只公开当前账号的文件摘要和待核对原因。 */
import { unseal } from "@/core/storage";
import type { TaskPayload, Target } from "@/shared/remote";
import { agentStore, requireTarget } from "./agents";
import { transaction } from "./store";
import type { TaskRecord } from "./tasks";
import { reconcileUploads, uploadId, type MaintenanceState } from "./upload-activities";
/** 七天过期不是终态证明，仍显示待核对记录供用户查询或取消。 */
export async function uploadRecovery(target: Target, actor: string) {
  await requireTarget(target.agentId, target.instanceId);
  const store = agentStore(target.agentId);
  return transaction(store, async () => {
    const queue = await store.read<{ records: TaskRecord[] }>("tasks.json");
    const records = queue?.records || [];
    await reconcileUploads(target.agentId, records);
    const state = await store.read<MaintenanceState>("maintenance.json");
    const ids = new Set<string>();
    const entries = records.filter(r => r.actor === actor && r.instanceId === target.instanceId && r.kind.startsWith("upload-")).flatMap(r => {
      const id = uploadId(r); if (!id || ids.has(id) || !state?.activities["upload:" + id]) return [];
      ids.add(id);
      const related = records.filter(t => uploadId(t) === id);
      const create = related.find(t => t.kind === "upload-create");
      const payload = create ? unseal<TaskPayload>(create.payload) : undefined;
      const pending = related.some(t => !["succeeded", "failed", "interrupted", "expired"].includes(t.status));
      return [{ id, instanceId: target.instanceId, agentId: target.agentId, filename: payload?.kind === "upload-create" ? payload.input.filename : "上传 " + id.slice(0, 8), message: pending ? "设备任务执行中或结果待确认；请查询后再取消。" : "上传尚未确认结束；请查询进度或取消临时上传。" }];
    });
    for (const key of Object.keys(state?.activities || {}).filter(k => k.startsWith("upload:"))) {
      const id = key.slice(7);
      if (!records.some(r => uploadId(r) === id)) entries.push({ id, ...target, filename: "旧上传 " + id.slice(0, 8), message: "旧记录归属待核对，请在原上传账号与目标查询；不能确认时保留阻塞。" });
    }
    return entries;
  }, "tasks.lock");
}
