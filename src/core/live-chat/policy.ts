/** 聊天错误与队列策略；使用固定公开文案，绝不保存上游正文或原始异常。 */
import { Temporal } from "@js-temporal/polyfill";
import { isAppError } from "../errors";
import type { LiveChatMessage } from "@/shared/live-chat";

export const MAX_AGE_MS = 120_000;
export const errorMessages: Record<string, string> = {
  AI_CONFIG: "DeepSeek 环境配置无效，请联系管理员检查直播电脑的 DEEPSEEK_API_KEY，然后重启客户端或显式重新启用互动。",
  AI_BALANCE: "DeepSeek 服务余额不足，请联系管理员检查环境 Key 对应账户的余额，然后重启客户端或显式重新启用互动。",
  YOUTUBE_AUTH: "YouTube 授权需要处理，请重新授权原频道后重新开启互动。",
  CHAT_UNAVAILABLE: "当前场次的实时聊天不可用，下一场直播会重新检查。",
  CHAT_QUOTA: "YouTube API 配额已耗尽，等待太平洋时间次日恢复。",
  CHAT_RATE: "YouTube 暂时限制发送频率，稍后自动重连。",
  CHAT_NETWORK: "聊天连接暂时中断，稍后从已保存位置重连。",
  CHAT_UNCERTAIN: "此次发送结果尚未确认，已停止重复发送该条回复。",
  AI_RATE: "DeepSeek 请求暂时受限，稍后恢复互动。",
  AI_NETWORK: "DeepSeek 暂时无法连接，稍后恢复互动。",
  AI_OUTPUT: "AI 未生成有效回复，已跳过此条消息。",
  CHAT_STORAGE: "聊天记录保存失败，请在原电脑检查数据目录后重新开启互动。",
};
/** 只识别应用登记过的代码，未知错误固定归为网络故障。 */
export function chatErrorCode(error: unknown, sending = false) {
  if (!isAppError(error)) return sending ? "CHAT_UNCERTAIN" : "CHAT_NETWORK";
  const aliases: Record<string, string> = { GOOGLE_AUTH: "YOUTUBE_AUTH", YOUTUBE_DISCONNECTED: "YOUTUBE_AUTH", GOOGLE_CONFIG: "YOUTUBE_AUTH", YOUTUBE_NETWORK: "CHAT_NETWORK", GOOGLE_NETWORK: "CHAT_NETWORK", YOUTUBE_QUOTA: "CHAT_RATE", YOUTUBE_DAILY_QUOTA: "CHAT_QUOTA", STORAGE: "CHAT_STORAGE" };
  return error.code in errorMessages ? error.code : aliases[error.code] || (sending ? "CHAT_UNCERTAIN" : "CHAT_NETWORK");
}
/** 使用太平洋当地日期求下一午夜，避免把夏令时日误当作固定 24 小时。 */
export function nextQuotaMidnight(now: number) {
  const next = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("America/Los_Angeles").toPlainDate().add({ days: 1 });
  return next.toZonedDateTime({ timeZone: "America/Los_Angeles", plainTime: "00:00" }).epochMilliseconds;
}
/** 同一观众两分钟内重复同文视为刷屏，跨观众的相同问候仍可分别回复。 */
export function spamKey(message: LiveChatMessage) { return JSON.stringify([message.authorId, message.text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()]); }
