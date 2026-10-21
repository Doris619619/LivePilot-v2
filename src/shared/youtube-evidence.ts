/** 平台证据的新鲜度和显示文案独立于Agent心跳；不改变后台缓存预算和轮询频率。 */
import type { Dashboard } from "./types";

/** 五分钟内且不来自未来的成功平台核对才能支持当前直播结论；缺失时间按未确认处理。 */
export function freshYouTubeEvidence(youtube: Dashboard["youtube"], now = Date.now()): boolean {
  const checked = Date.parse(youtube.checkedAt || "");
  return youtube.query !== "failed" && Number.isFinite(checked) && checked <= now + 5000 && now - checked <= 300_000;
}

/** 只说明真实核对时间和缓存年龄；下次后台检查是预算安排，不承诺一定查到平台。 */
export function youtubeEvidenceTime(youtube: Dashboard["youtube"], now = Date.now()): string {
  const checked = Date.parse(youtube.checkedAt || "");
  if (!Number.isFinite(checked) || checked > now + 5000) return "尚无平台核对时间";
  const age = Math.max(0, Math.floor((now - checked) / 60_000));
  return `上次平台核对：${new Date(checked).toLocaleString("zh-CN")}（${age < 1 ? "不到1分钟" : age + "分钟前"}）`;
}

/** 同一场次的迟到心跳不能覆盖人工刚核对的证据；新场次、授权变化和新的读取失败仍按新响应处理。 */
export function mergeDashboardEvidence(previous: Dashboard | undefined, incoming: Dashboard): Dashboard {
  if (!previous || previous.device?.agentId !== incoming.device?.agentId) return incoming;
  if (previous.device?.observedAt && incoming.device?.observedAt && previous.device.observedAt > incoming.device.observedAt) return previous;
  const same = previous.state.broadcastId && previous.state.broadcastId === incoming.state.broadcastId && previous.state.phase === incoming.state.phase && previous.state.channelId === incoming.state.channelId && previous.youtube.channelId === incoming.youtube.channelId;
  return same && incoming.youtube.query !== "failed" && Date.parse(previous.youtube.checkedAt || "") > Date.parse(incoming.youtube.checkedAt || "")
    ? { ...incoming, youtube: previous.youtube } : incoming;
}
