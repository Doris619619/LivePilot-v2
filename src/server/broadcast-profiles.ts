/** 直播配置包归属登录账号；旧目录只读复制，设备和频道仅作为迁移线索。 */
import "server-only";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Member } from "./access";
import { agentStore } from "@/cloud/agents";
import { cloudStore } from "@/cloud/store";
import { cloudMode, config, dataRoot, instanceIds } from "@/core/config";
import { Store } from "@/core/storage";
import { readBroadcastProfiles, importBroadcastProfiles } from "@/core/broadcast-profiles";
import { YouTubeAuth } from "@/core/youtube/auth";
import type { BroadcastProfileTarget } from "@/shared/broadcast-profiles";

/** 只由会话账号计算新旧目录，不接受其他客户身份；旧目标不能授予控制或跨账号读取。 */
export async function broadcastProfilesStore(user: Member, hint?: BroadcastProfileTarget) {
  const store = new Store(path.join(dataRoot(), "broadcast-profile-library", createHash("sha256").update(user.username).digest("hex")));
  const targets: BroadcastProfileTarget[] = hint ? [hint] : [];
  if (cloudMode()) {
    const registry = await cloudStore().read<{ agents: { id: string; instances: { id: string }[] }[] }>("agents.json");
    targets.push(...await cloudStore().read<BroadcastProfileTarget[]>("bindings.json") || []);
    for (const agent of registry?.agents || []) {
      const beat = await agentStore(agent.id).read<{ snapshots: { instance: { id: string }; dashboard: { youtube: { channelId?: string } } }[] }>("heartbeat.json");
      for (const snapshot of beat?.snapshots || []) if (snapshot.dashboard.youtube.channelId) targets.push({ agentId: agent.id, instanceId: snapshot.instance.id, channelId: snapshot.dashboard.youtube.channelId });
    }
    // 旧发布记录可恢复曾换绑的频道线索；最终目录仍必须匹配当前登录账号的摘要。
    const history = await new Store(path.join(cloudStore().dir, "publishing")).read<{ profiles?: { value: BroadcastProfileTarget }[]; plans?: { profile: BroadcastProfileTarget }[] }>("state.json");
    targets.push(...(history?.profiles || []).map(item => item.value), ...(history?.plans || []).map(item => item.profile));
  }
  if (!cloudMode()) for (const instanceId of instanceIds()) {
    const tokens = await new YouTubeAuth(new Store(config(instanceId).dataDir), instanceId).tokens();
    if (tokens?.channelId) targets.push({ instanceId, channelId: tokens.channelId });
  }
  const sources = new Map<string, Store>();
  for (const target of targets) {
    if (!cloudMode() && (target.agentId || !instanceIds().includes(target.instanceId))) continue;
    const root = cloudMode() ? cloudStore().dir : config(target.instanceId).dataDir;
    const key = createHash("sha256").update(JSON.stringify([user.username, target.agentId || "local", target.instanceId, target.channelId])).digest("hex");
    sources.set(key, new Store(path.join(root, "broadcast-profiles", key)));
  }
  await importBroadcastProfiles(store, await Promise.all([...sources].map(async ([key, source]) => ({ key, profiles: await readBroadcastProfiles(source) }))));
  return store;
}
