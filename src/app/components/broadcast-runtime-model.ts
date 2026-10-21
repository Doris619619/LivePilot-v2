/** 文件用途：将网页开播区的多方状态归纳为一个结论，并限制不确定场次先核对再重试；不发送控制命令。 */
import { broadcastActionMode, canStopBroadcast } from "@/shared/readiness";
import { canResumeBroadcast, hasPendingBroadcast } from "@/shared/broadcast-recovery";
import type { Dashboard } from "@/shared/types";
import type { StatusType } from "./status-indicator";

type RuntimeInput = { data?: Dashboard; stale: boolean; busy: boolean; live: boolean; error?: string; working?: string };
export type RuntimeSummary = { status: StatusType; label: string; message: string };

/** 恢复只沿已保存的原场次推进；已启动 OBS 的中断命令可显式再核对，不自动创建直播。 */
export function runtimeActionMode({ data, stale, busy, live }: RuntimeInput) {
  const mode = broadcastActionMode(data, busy, stale, live);
  if (data?.state.platformClosePending || data?.state.stopRequested && data.state.phase !== "stopped") return mode === "working" ? mode : "check";
  if (!stale && !busy && !live && data) {
    if (data.operation?.action === "launch" && data.operation.status === "interrupted" && !hasPendingBroadcast(data.state) && data.obs.ready && data.obs.streaming === false) return "confirm-obs";
    if (canResumeBroadcast(data)) return "resume";
  }
  if (mode === "retry" && data && (data.obs.streaming === true || data.youtube.lifecycle === "live" || data.youtube.query === "failed" && canStopBroadcast(data))) return "check";
  return mode;
}

/** 以新鲜的 OBS 和平台信号解释结论；内部阶段名称不能作为开播成功的证据。 */
export function runtimeSummary(input: RuntimeInput): RuntimeSummary {
  const { data, stale, error, live, working } = input;
  if (stale) return { status: "stale", label: "状态待更新", message: "连接已中断，当前是否在播尚不确定。请重新检查状态。" };
  if (!data) return { status: "busy", label: "正在读取状态", message: "" };
  if (data.state.platformClosePending && data.obs.streaming === false && (data.youtube.lifecycle !== "complete" || data.youtube.query === "failed")) return { status: "error", label: "OBS 已停止，平台待结束", message: "YouTube 场次尚未确认结束。恢复配额或网络后重试结束，或到 YouTube Studio 手动核对。" };
  if (runtimeActionMode(input) === "working") return { status: "busy", label: working === "stop" || data.state.phase === "stopping" ? "正在结束直播" : "正在处理", message: "等待设备确认，请勿重复操作。" };
  if (data.obs.reconnecting) return { status: "error", label: "推流重连中", message: "OBS 正在恢复连接，直播信号可能中断。" };
  if (live) return error || data.state.error
    ? { status: "error", label: "直播中，需处理", message: "推流已确认，最近操作出现问题。请查看上方提示。" }
    : { status: "live", label: "直播中", message: "" };
  if (data.youtube.lifecycle === "live" && data.obs.streaming === false) return { status: "error", label: "推流中断", message: "OBS 未推流，YouTube 场次仍在直播。请先重新检查状态。" };
  if (data.obs.streaming === true) return { status: "error", label: "直播信号待确认", message: data.youtube.lifecycle === "complete" ? "OBS 仍在推流，YouTube 场次已结束。请重新检查状态。" : "OBS 正在推流，尚未确认 YouTube 收到直播信号。" };
  if (data.obs.streaming === false && data.youtube.query !== "failed" && data.youtube.lifecycle === "complete" && hasPendingBroadcast(data.state)) return { status: "standby", label: "本场已结束", message: "确认结束后可更换下一场素材。" };
  if (data.youtube.lifecycle === "live" || runtimeActionMode(input) === "check") return { status: "error", label: "直播状态待核对", message: "尚未确认直播信号，请先重新检查状态。" };
  if (error || data.state.phase === "error" || data.operation?.status === "failed") return { status: "error", label: "操作未完成", message: "请查看上方原因，处理后重试。" };
  if (data.state.phase === "stopped") return { status: "standby", label: "本场已结束", message: "" };
  return { status: "ready", label: "等待开播", message: "" };
}

/** 只使用本场场次 ID 生成观众观看页，不以频道首页或 Studio 编辑页替代。 */
export function broadcastWatchUrl(broadcastId?: string): string | undefined {
  return broadcastId?.trim() ? `https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId.trim())}` : undefined;
}

/** 没有新鲜、有效的正在推流计时就显示破折号，不能用零时长冒充已确认计时。 */
export function runtimeDuration(data: Dashboard | undefined, stale: boolean, durationMs: number | null): string {
  if (stale || !data?.obs.streaming || durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const total = Math.floor(durationMs / 1000);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, "0")).join(":");
}
