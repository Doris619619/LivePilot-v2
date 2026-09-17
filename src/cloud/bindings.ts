/** 全局频道永久归属；断线不会释放，失败占用保留供原设备恢复。 */
import { cloudStore, transaction } from "./store";
import { AppError } from "@/core/errors";
import { requireTarget } from "./agents";
import type { Target } from "@/shared/remote";
type Binding = Target & { channelId: string; confirmed: boolean };
/** 持久化占用发生在 Agent 保存令牌之前；重复占用由同一设备恢复。 */
export async function claimChannel(target: Target, channelId: string, confirm = false) {
  await requireTarget(target.agentId, target.instanceId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw new AppError("CHANNEL", "频道标识无效。");
  const store = cloudStore();
  await transaction(store, async () => {
    const bindings = await store.read<Binding[]>("bindings.json") || [];
    const owner = bindings.find(b => b.channelId === channelId);
    if (owner && (owner.agentId !== target.agentId || owner.instanceId !== target.instanceId)) throw new AppError("CHANNEL_IN_USE", "该频道已属于另一台电脑或 OBS，请选择独立频道。", 409);
    if (owner) owner.confirmed ||= confirm; else bindings.push({ ...target, channelId, confirmed: confirm });
    await store.write("bindings.json", bindings);
  }, "bindings.lock");
}
