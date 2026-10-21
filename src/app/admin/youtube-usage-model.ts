/** YouTube 数据台的时间、筛选和展示口径；所有数字来自本应用计量，不能作为 Google 实扣。 */
import type { StoredYouTubeEvent, YouTubeUsageQuery, YouTubeUsageSummary } from "@/shared/youtube-usage";
export const purposeLabels: Record<string, string> = { background: "后台状态", control: "开停播", interactive: "主动查询", "chat-send": "聊天发送", "chat-stream": "聊天室连接", publishing: "视频发布", authorization: "授权验证" };
export const outcomeLabels: Record<string, string> = { succeeded: "成功", failed: "失败", unknown: "结果未知", cancelled: "已取消" };
export const blockReasonLabels: Record<string, string> = { YOUTUBE_DAILY_QUOTA: "Google 每日配额耗尽", YOUTUBE_BASELINE_UNKNOWN: "当日基线未知", YOUTUBE_BUDGET: "项目预算不足", YOUTUBE_PURPOSE_BUDGET: "功能预算已达上限", YOUTUBE_PUBLISHING_BUDGET: "发布预算已达上限", YOUTUBE_RATE: "等待请求速率恢复", YOUTUBE_PROJECT_UNKNOWN: "项目映射未确认", YOUTUBE_ATTEMPT_EXPIRED: "旧配额日的准入已过期", YOUTUBE_ATTEMPT_FINISHED: "此请求已完成", YOUTUBE_PROTECTION_OFFLINE: "配额保护未连接", YOUTUBE_PROTECTION_STORAGE: "保护记录暂不可读", YOUTUBE_PROJECT_UNMAPPED: "本机项目尚未映射", PROTECTION_OFFLINE: "配额保护未连接", PROTECTION_STORAGE: "保护记录暂不可读", PROJECT_UNMAPPED: "本机项目尚未映射" };
/** 按美国太平洋日期设置默认配额日，不能使用纽约或浏览器本地午夜。 */
export function pacificToday(at = Date.now()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(at); }
/** 用已知 query 白名单构造只读参数；空筛选不发送。 */
export function usageQuery(query: YouTubeUsageQuery) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value)); return params.toString(); }
/** 完成事件不重复记费；上传和搜索使用独立桶，分片独立成本尚未核实。 */
export function eventCostLabel(event: Pick<StoredYouTubeEvent, "kind" | "method" | "estimatedUnits">): string {
  if (event.kind !== "start") return "—";
  if (event.method === "videos.insert") return "上传桶 1 次";
  if (event.method === "search.list") return "搜索桶 1 次";
  if (event.method === "videos.upload.chunk" || event.method === "videos.upload.probe") return "独立成本未核实";
  if (event.method.startsWith("oauth.")) return "不计 Data API";
  return event.estimatedUnits === null ? "未核实" : String(event.estimatedUnits);
}
/** 仅以最近一小时已记录速率推算；没有消费或预算数据时不生成虚假倒计时。 */
export function exhaustionLabel(summary: YouTubeUsageSummary, now = Date.now()) {
  if (!summary.baseline.known) return "基线未知";
  if (summary.remainingUnits <= 0) return "预算已用完";
  const recent = summary.minutes.filter(item => item.minute >= now - 3600_000 && item.minute <= now);
  const units = recent.reduce((sum, item) => sum + item.units, 0);
  if (!units) return "暂无持续消耗";
  const elapsed = Math.max(60_000, Math.min(3600_000, now - Math.min(...recent.map(item => item.minute)) + 60_000));
  const minutes = Math.ceil(summary.remainingUnits / (units / elapsed) / 60_000);
  return minutes < 60 ? `约 ${minutes} 分钟` : `约 ${Math.round(minutes / 60 * 10) / 10} 小时`;
}
