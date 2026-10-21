/** 桌面实例名称与安全停用：保留退休历史和本机文件，仅从活跃库存释放已确认空闲的目标。 */
import path from "node:path";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import { publishingTerminal, type PublishingAccount, type VideoJob } from "@/shared/publishing";
import { idSchema, OFFLINE_MS, type AgentSnapshot } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
import { agentStore, listAgents } from "./agents";
import { reconcileRetiredChannels, releaseTargetChannels } from "./bindings";
import { cloudStore, transaction } from "./store";
import { terminal, type TaskRecord } from "./tasks";
type Inventory = { agents: { id: string; revoked: boolean; instances: InstanceDescriptor[]; retiredInstanceIds?: string[] }[] };
type Retirement = { instance: InstanceDescriptor; retiredAt: number; channels: string[] };
/** 只返回本设备的公开清单；用于清单提交响应丢失后在建立新会话前核对真实库存。 */
export async function instanceInventory(agentId: string) {
  const store = cloudStore();
  return transaction(store, async () => {
    const registry = await store.read<Inventory>("agents.json"); const agent = registry?.agents.find(a => a.id === agentId && !a.revoked);
    if (!agent) throw new AppError("INSTANCE", "目标设备不存在。", 404);
    // 库存本身只读；返回前完成已提交墓碑的幂等清理，失败不能被桌面误认为退休全部完成。
    await reconcileRetiredChannels(store, agentId);
    return { instances: agent.instances, retiredInstanceIds: agent.retiredInstanceIds || [] };
  });
}
/** 仅编辑显示名称；设备会话和业务目标始终使用不可变 ID，直播中也不需要维护锁。 */
export async function renameInstance(agentId: string, id: string, name: string) {
  if (!idSchema.safeParse(id).success || !name.trim() || name.trim().length > 80) throw new AppError("INPUT", "实例名称必须为 1–80 字。");
  const store = cloudStore();
  return transaction(store, async () => {
    const registry = await store.read<Inventory>("agents.json"); const agent = registry?.agents.find(a => a.id === agentId && !a.revoked); const instance = agent?.instances.find(i => i.id === id);
    if (!registry || !instance) throw new AppError("INSTANCE", "目标实例不存在或已停用。", 404);
    instance.name = name.trim(); await store.write("agents.json", registry); return { ok: true };
  });
}
/** 维护冻结入队后再次检查实时证据；未知OBS/频道、未完成上传和发布账号均不能被停用绕过。 */
export async function retireInstance(agentId: string, id: string, token: string) {
  if (!idSchema.safeParse(id).success || id === "main") throw new AppError("INSTANCE", "主实例需要保留；请在原客户端修复连接或路径。", 409);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("INPUT", "维护凭据无效。");
  const cloud = cloudStore(), local = agentStore(agentId), publishing = new Store(path.join(cloud.dir, "publishing"));
  // 与发布调度相同的 publishing -> tasks 顺序，防止改计划与退休同时通过。
  return transaction(publishing, () => transaction(local, async () => {
    const maintenance = await local.read<{ token?: string; activities: Record<string, number> }>("maintenance.json");
    if (maintenance?.token !== token) throw new AppError("MAINTENANCE", "请先在原客户端完成安全维护检查。", 409);
    if (Object.entries(maintenance.activities).some(([key, expires]) => key.startsWith("upload:") || expires > Date.now())) throw new AppError("BUSY", "仍有上传或频道授权未结束，请先处理后停用。", 409);
    const queue = await local.read<{ records: TaskRecord[] }>("tasks.json");
    if (queue?.records.some(record => !terminal(record.status) && !(record.status === "queued" && record.expiresAt < Date.now()))) throw new AppError("BUSY", "设备仍有执行中或结果待确认的任务，不能停用。", 409);
    const runtime = await local.read<{ busy: boolean }>("publishing-runtime.json"); if (runtime?.busy) throw new AppError("BUSY", "普通视频尚未到安全检查点，不能停用。", 409);
    const state = await publishing.read<{ jobs: VideoJob[] }>("state.json");
    if (state?.jobs.some(job => job.spec.profile.agentId === agentId && job.spec.profile.instanceId === id && (!publishingTerminal(job.observed?.state) || job.observed?.revision !== job.spec.revision))) throw new AppError("BUSY", "该实例仍有未结束的发布任务，请先处理后停用。", 409);
    return transaction(cloud, async () => {
      const registry = await cloud.read<Inventory>("agents.json"); const agent = registry?.agents.find(a => a.id === agentId && !a.revoked);
      if (!registry || !agent) throw new AppError("INSTANCE", "目标设备不存在。", 404);
      const instance = agent.instances.find(i => i.id === id); const retired = agent.retiredInstanceIds?.includes(id);
      if (!instance && !retired) throw new AppError("INSTANCE", "目标实例不存在。", 404);
      if (instance) {
        const online = (await listAgents()).find(a => a.id === agentId)?.online; const beat = await local.read<{ snapshots: AgentSnapshot[] }>("heartbeat.json"); const snapshot = beat?.snapshots.find(s => s.instance.id === id); const d = snapshot?.dashboard;
        if (!online || !snapshot || snapshot.observedAt <= Date.now() - OFFLINE_MS || !d || d.busy || d.obs.streaming !== false || !["idle", "stopped"].includes(d.state.phase) || d.youtube.error || d.state.broadcastId && !["complete", "revoked", "missing"].includes(d.youtube.lifecycle || "")) throw new AppError("BUSY", "尚未确认该实例已停止推流和场次，请先查询原频道。", 409);
        const accounts = await cloud.read<{ accounts: { value: PublishingAccount }[] }>("publishing-accounts.json");
        if (accounts?.accounts.some(record => record.value.agentId === agentId && record.value.instanceId === id && record.value.status !== "deleted")) throw new AppError("BUSY", "实例仍关联独立发布账号，不能直接停用；原授权和工作保留，请先在发布模块核对处理，或恢复程序继续使用。", 409);
        const history = await local.read<Retirement[]>("retired-instances.json") || [];
        const bindings = await cloud.read<{ agentId: string; instanceId: string; channelId: string }[]>("bindings.json") || [];
        if (!history.some(record => record.instance.id === id)) history.push({ instance, retiredAt: Date.now(), channels: bindings.filter(binding => binding.agentId === agentId && binding.instanceId === id).map(binding => binding.channelId) });
        await local.write("retired-instances.json", history);
        agent.retiredInstanceIds = [...new Set([...(agent.retiredInstanceIds || []), id])]; agent.instances = agent.instances.filter(i => i.id !== id);
        // 先持久化停用事实；释放失败时凭墓碑重试，旧在途绑定请求也不能重新占位。
        await cloud.write("agents.json", registry);
      }
      await releaseTargetChannels(cloud, { agentId, instanceId: id }); return { ok: true };
    });
  }, "tasks.lock"), "publishing.lock");
}
