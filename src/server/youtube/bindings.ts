/** 在授权写入时保证每个本机实例绑定不同频道；不串行化直播控制。 */
import "server-only";
import { config, instanceIds } from "../config";
import { Store, seal, unseal } from "../storage";
import { AppError } from "../errors";

/** 短时跨进程锁保护频道归属检查及授权保存；密文不进入日志。 */
export async function saveChannelBinding(id: string, tokens: { channelId: string }) {
  const root = new Store(config().dataDir);
  await root.exclusive(async () => {
    for (const other of instanceIds()) {
      if (other === id) continue;
      const encrypted = await new Store(config(other).dataDir).read<string>("youtube.enc");
      if (encrypted && unseal<{ channelId: string }>(encrypted).channelId === tokens.channelId) throw new AppError("CHANNEL_IN_USE", "这个 YouTube 频道已连接到另一个 OBS。请为当前实例选择不同频道。", 409);
    }
    await new Store(config(id).dataDir).write("youtube.enc", seal(tokens));
  }, "oauth-bindings.lock");
}
