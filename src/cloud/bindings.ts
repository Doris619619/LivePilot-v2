/** 全局频道归属：离线保留，匹配确认后安全迁移；与设备身份变更和实例停用共用短锁。 */
import { cloudStore, transaction } from "./store";
import { AppError } from "@/core/errors";
import { requireTarget } from "./agents";
import type { Target } from "@/shared/remote";
import type { Store } from "@/core/storage";
import { randomUUID } from "node:crypto";
type Binding = Target & { channelId: string; confirmed: boolean };
type Claim = Target & { channelId: string; claimId: string; confirmed: boolean };
/** 调用方持 metadata.lock；撤销目标时一并清除版本栅栏，旧设备凭据不能继续提交。 */
export async function releaseTargetChannels(store: Store, target: Target) {
  const bindings = await store.read<Binding[]>("bindings.json") || [];
  const claims = await store.read<Claim[]>("channel-claims.json") || [];
  await store.write("bindings.json", bindings.filter(b => b.agentId !== target.agentId || b.instanceId !== target.instanceId));
  await store.write("channel-claims.json", claims.filter(b => b.agentId !== target.agentId || b.instanceId !== target.instanceId));
}
/** 调用方必须持有云端 metadata.lock；先持久化撤销，再释放该设备占用，失败可重试。 */
export async function releaseAgentChannels(store: Store, agentId: string) {
  const bindings = await store.read<Binding[]>("bindings.json") || [];
  const retained = bindings.filter(b => b.agentId !== agentId);
  if (retained.length !== bindings.length) await store.write("bindings.json", retained);
  const claims = await store.read<Claim[]>("channel-claims.json");
  if (claims?.some(c => c.agentId === agentId)) await store.write("channel-claims.json", claims.filter(c => c.agentId !== agentId));
  return bindings.length - retained.length;
}
/** 持锁清理历史已移除设备的占用；未知设备记录保留，不将离线当作移除。 */
async function reconcileRemoved(store: Store) {
  const registry = await store.read<{ agents: { id: string; revoked: boolean }[] }>("agents.json");
  const removed = new Set(registry?.agents.filter(a => a.revoked).map(a => a.id));
  const bindings = await store.read<Binding[]>("bindings.json") || [];
  const retained = bindings.filter(b => !removed.has(b.agentId));
  if (retained.length !== bindings.length) await store.write("bindings.json", retained);
  const claims = await store.read<Claim[]>("channel-claims.json");
  if (claims?.some(c => removed.has(c.agentId))) await store.write("channel-claims.json", claims.filter(c => !removed.has(c.agentId)));
  return bindings.length - retained.length;
}
/** 部署后可安全重复执行，只释放明确已撤销的登记，不读取或修改本机授权。 */
export async function reconcileRemovedChannelBindings() {
  const store = cloudStore(); return transaction(store, () => reconcileRemoved(store));
}
/** 预占保留旧频道；只有最新预占在本机保存后确认，才原子释放同目标旧绑定。 */
export async function claimChannel(target: Target, channelId: string, confirm = false, claimId?: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw new AppError("CHANNEL", "频道标识无效。");
  const store = cloudStore();
  return transaction(store, async () => {
    // 在身份变更使用的同一把锁内重新确认，阻止在途请求于撤销后重新占位。
    await requireTarget(target.agentId, target.instanceId);
    await reconcileRemoved(store);
    const bindings = await store.read<Binding[]>("bindings.json") || [];
    const claims = await store.read<Claim[]>("channel-claims.json") || [];
    let claim = claims.find(c => c.agentId === target.agentId && c.instanceId === target.instanceId);
    const owner = bindings.find(b => b.channelId === channelId);
    if (owner && (owner.agentId !== target.agentId || owner.instanceId !== target.instanceId)) throw new AppError("CHANNEL_IN_USE", "该频道已连接到另一台电脑或 OBS。请先移除原电脑后再连接，或选择其他频道。", 409);
    if (confirm && claim && (claim.channelId !== channelId || claimId && claim.claimId !== claimId)) {
      // 旧客户端启动登记仍可确认原频道存在，但不能取消正在保存的新预占或回滚已完成迁移。
      if (!claimId && !claim.confirmed && owner?.confirmed) return { ok: true };
      throw new AppError("CHANNEL_STALE", "频道连接已更新，请刷新原实例后重新连接。", 409);
    }
    if (!claim || !confirm && claim.channelId !== channelId) {
      claim = { ...target, channelId, claimId: randomUUID(), confirmed: false };
      const index = claims.findIndex(c => c.agentId === target.agentId && c.instanceId === target.instanceId);
      if (index < 0) claims.push(claim); else claims[index] = claim;
    }
    if (confirm && claimId && claim.claimId !== claimId) throw new AppError("CHANNEL_STALE", "频道连接已更新，请重新连接。", 409);
    if (owner) owner.confirmed ||= confirm; else bindings.push({ ...target, channelId, confirmed: confirm });
    if (confirm) claim.confirmed = true;
    // 先保存版本栅栏；释放写入失败时重试同一确认仍可完成，迟到旧确认不能倒退。
    await store.write("channel-claims.json", claims);
    await store.write("bindings.json", confirm ? bindings.filter(b => b.agentId !== target.agentId || b.instanceId !== target.instanceId || b.channelId === channelId) : bindings);
    return { ok: true, claimId: claim.claimId };
  });
}
