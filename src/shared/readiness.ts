/** 将开播前置条件转为面板可见原因；服务端仍执行完整控制校验。 */
import type { Dashboard, Selection } from "./types";
import { broadcastSchema } from "./broadcast";
import { blocksStart } from "./problem-policy";
/** 返回第一个阻塞原因，空字符串表示可以提交开播或恢复请求。 */
export function startBlocker(data: Dashboard | undefined, selection: Selection, busy: boolean, stale: boolean, live: boolean): string {
  if (stale) return "状态已过期，请检查服务并刷新";
  if (!data) return "正在读取这个实例的状态";
  if (busy) return "当前实例正在处理操作";
  if (live) return "这个实例正在直播";
  const problem = data.problems?.find(blocksStart);
  if (problem) return problem.message;
  if (data.configuration.missing.length) return "请先完成面板列出的本机配置";
  if ((data.obs.problem && blocksStart(data.obs.problem)) || data.obs.processKnown === false || (data.obs.running && !data.obs.ready)) return data.obs.message || "请先恢复此 OBS 的控制连接";
  if (data.youtube.error) return data.youtube.error;
  if (data.media.error) return "素材暂不可读取，请在此电脑检查目录后重新读取";
  if (!data.youtube.connected) return "请先连接这个实例的 YouTube 频道";
  if (!selection.video || !data.media.videos.includes(selection.video)) return "请选择一个可用的视频";
  if (!selection.music || !data.media.music.includes(selection.music)) return "请选择一段可用的音乐";
  if (selection.broadcast) { const checked = broadcastSchema.safeParse(selection.broadcast); if (!checked.success) return checked.error.issues[0]?.message || "请检查直播详情"; }
  return "";
}

/** 空闲实例不发送结束命令；部分开播、异常恢复和 OBS 正在推流仍保留停止入口。 */
export function canStopBroadcast(data?: Dashboard): boolean {
  return !!data && (data.obs.streaming === true || !!data.state.broadcastIntent || (!!data.state.broadcastTitle && data.state.phase !== "stopped") || !["idle", "stopped"].includes(data.state.phase));
}
/** 对观众可理解的场次状态；未知平台枚举不直接泄漏到界面。 */
export function youtubeLifecycleLabel(value?: string): string {
  const labels: Record<string, string> = { created: "待开播", ready: "准备就绪", testing: "测试中", testStarting: "正在开始测试", liveStarting: "正在开播", live: "直播中", complete: "已结束", revoked: "已撤销", missing: "未找到场次" };
  return value ? labels[value] || "状态待确认" : "—";
}
