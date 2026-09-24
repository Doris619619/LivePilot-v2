/** 桌面逐实例准备状态；素材库存在不代表网页已经选好开播素材。 */
import type { Check, PublicInstance } from "./desktop";
import type { AgentSnapshot } from "./remote";
/** 只采用新鲜控制结果；网络隔离检查不能覆盖实际控制成功。 */
export function obsReadiness(instance: PublicInstance, check: Check | undefined, snapshot: AgentSnapshot | undefined, now: number) {
  const dashboard = snapshot?.instance.id === instance.id && now - snapshot.observedAt < 20_000 ? snapshot.dashboard : undefined;
  const local = check?.instanceId === instance.id && check.checkedAt && now - check.checkedAt < 20_000 ? check : undefined;
  const control = dashboard && (!local?.checkedAt || snapshot!.observedAt >= local.checkedAt) ? dashboard.obs.ready : !!local?.controlReady || local?.status === "ready";
  const channel = !!dashboard?.youtube.connected && !dashboard.youtube.error;
  const media = !!dashboard && !dashboard.media.error && dashboard.media.videos.length > 0 && dashboard.media.music.length > 0;
  const live = dashboard?.obs.streaming === true;
  const ready = instance.initialized && control && channel && media && !dashboard?.configuration.missing.length;
  return { control, channel, media, live, ready, dashboard, label: live ? "直播中" : ready ? "准备完成" : !instance.initialized ? "待配置" : !dashboard && !local ? "待检查" : "待配置" };
}
