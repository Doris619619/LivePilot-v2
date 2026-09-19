/** 全局频道归属：离线保留，明确移除设备后释放；与设备身份变更共用短锁。 */
import { cloudStore, transaction } from "./store";
import { AppError } from "@/core/errors";
import { requireTarget } from "./agents";
import type { Target } from "@/shared/remote";
import type { Store } from "@/core/storage";
type Binding = Target & { channelId: string; confirmed: boolean };
/** 调用方必须持有云端 metadata.lock；先持久化撤销，再释放该设备占用，失败可重试。 */
export async function releaseAgentChannels(store: Store, agentId: string) {
  const bindings = await store.read<Binding[]>("bindings.json") || [];
  const retained = bindings.filter(b => b.agentId !== agentId);
  if (retained.length !== bindings.length) await store.write("bindings.json", retained);
  return bindings.length - retained.length;
}
/** 持锁清理历史已移除设备的占用；未知设备记录保留，不将离线当作移除。 */
async function reconcileRemoved(store: Store) {
  const registry = await store.read<{ agents: { id: string; revoked: boolean }[] }>("agents.json");
  const removed = new Set(registry?.agents.filter(a => a.revoked).map(a => a.id));
  const bindings = await store.read<Binding[]>("bindings.json") || [];
  const retained = bindings.filter(b => !removed.has(b.agentId));
  if (retained.length !== bindings.length) await store.write("bindings.json", retained);
  return bindings.length - retained.length;
}
/** 部署后可安全重复执行，只释放明确已撤销的登记，不读取或修改本机授权。 */
export async function reconcileRemovedChannelBindings() {
  const store = cloudStore(); return transaction(store, () => reconcileRemoved(store));
}
/** 持久化占用发生在 Agent 保存令牌之前；重复占用由同一设备恢复。 */
export async function claimChannel(target: Target, channelId: string, confirm = false) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw new AppError("CHANNEL", "频道标识无效。");
  const store = cloudStore();
  await transaction(store, async () => {
    // 在身份变更使用的同一把锁内重新确认，阻止在途请求于撤销后重新占位。
    await requireTarget(target.agentId, target.instanceId);
    await reconcileRemoved(store);
    const bindings = await store.read<Binding[]>("bindings.json") || [];
    const owner = bindings.find(b => b.channelId === channelId);
    if (owner && (owner.agentId !== target.agentId || owner.instanceId !== target.instanceId)) throw new AppError("CHANNEL_IN_USE", "该频道已连接到另一台电脑或 OBS。请先移除原电脑后再连接，或选择其他频道。", 409);
    if (owner) owner.confirmed ||= confirm; else bindings.push({ ...target, channelId, confirmed: confirm });
    await store.write("bindings.json", bindings);
  });
}
