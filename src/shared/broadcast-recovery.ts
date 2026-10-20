/** 文件用途：区分可编辑的下一场草稿和必须沿原场次恢复的执行快照，不凭内部阶段猜测平台结果。 */
import type { ControlState, Dashboard } from "./types";

/** 只有已产生场次身份或创建意图的非终态记录才固定素材；场次创建前失败仍允许编辑。 */
export function hasPendingBroadcast(state: ControlState): boolean {
  return !["idle", "stopped"].includes(state.phase) && !!(state.broadcastId || state.broadcastIntent || state.broadcastTitle);
}

/** 新鲜查询确认原场次仍可准备时才显示显式继续；未知交付、已直播和已结束不能盲目重放。 */
export function canResumeBroadcast(data: Dashboard): boolean {
  if (!hasPendingBroadcast(data.state) || !data.state.selection || data.state.phase === "stopping") return false;
  if (data.busy || ["queued", "delivering", "accepted", "running", "uncertain"].includes(data.operation?.status || "")) return false;
  if (!data.obs.ready || data.obs.streaming === null || !data.youtube.connected || data.youtube.query === "failed") return false;
  return data.state.broadcastId
    ? ["created", "ready", "liveStarting"].includes(data.youtube.lifecycle || "")
    : data.state.broadcastIntent === true;
}
