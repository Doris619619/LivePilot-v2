/** 将开播前置条件转为面板可见原因；服务端仍执行完整控制校验。 */
import type { Dashboard, Selection } from "./types";
/** 返回第一个阻塞原因，空字符串表示可以提交开播或恢复请求。 */
export function startBlocker(data: Dashboard | undefined, selection: Selection, busy: boolean, stale: boolean, live: boolean): string {
  if (stale) return "状态已过期，请检查服务并刷新";
  if (!data) return "正在读取这个实例的状态";
  if (busy) return "当前实例正在处理操作";
  if (live) return "这个实例正在直播";
  if (data.configuration.missing.length) return "请先完成面板列出的本机配置";
  if (!data.youtube.connected) return "请先连接这个实例的 YouTube 频道";
  if (!selection.video || !data.media.videos.includes(selection.video)) return "请选择一个可用的视频";
  if (!selection.music || !data.media.music.includes(selection.music)) return "请选择一段可用的音乐";
  return "";
}
