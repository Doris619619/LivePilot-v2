/** 直播配置按设备所有者、实例与授权频道隔离；管理员协助使用同一份配置并留下审计。 */
import "server-only";
import path from "node:path";
import { createHash } from "node:crypto";
import { type Member, requireAdmin } from "./access";
import { authorizeAgent } from "./ownership";
import { requireTarget, snapshotFor } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { cloudMode, config } from "@/core/config";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import { service } from "./service";
import type { BroadcastProfileTarget } from "@/shared/broadcast-profiles";

/** 客户端声明的频道必须匹配服务端快照；换绑频道或转移设备不能读到原配置。 */
export async function broadcastProfilesStore(user: Member, target: BroadcastProfileTarget) {
  let owner = user.username, root: string, channelId: string | undefined;
  if (cloudMode()) {
    if (!target.agentId) throw new AppError("TARGET", "请选择直播电脑。", 400);
    const agent = await authorizeAgent(user, target.agentId);
    await requireTarget(target.agentId, target.instanceId);
    owner = agent.owner || user.username;
    channelId = (await snapshotFor(target.agentId, target.instanceId))?.dashboard.youtube.channelId;
    root = cloudStore().dir;
  } else {
    requireAdmin(user);
    if (target.agentId) throw new AppError("TARGET", "本机模式不接受远程电脑。", 400);
    channelId = (await service(target.instanceId).dashboard()).youtube.channelId;
    root = config(target.instanceId).dataDir;
  }
  if (!channelId || target.channelId !== channelId) throw new AppError("CHANNEL", "频道尚未确认或已切换，请刷新频道状态后再使用直播配置。", 409);
  const key = createHash("sha256").update(JSON.stringify([owner, target.agentId || "local", target.instanceId, channelId])).digest("hex");
  return new Store(path.join(root, "broadcast-profiles", key));
}
