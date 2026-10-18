/** 不依赖模型的接话边界与语言检查；不把无法识别的文本武断认作笔误。 */
import type { LiveChatConfig, LiveChatEntry, LiveChatMessage } from "@/shared/live-chat";

/** 被叫模式只允许昵称、助手称呼或近期已回应后的直接跟进；@其他观众不会触发。 */
export function shouldAddress(config: LiveChatConfig, message: LiveChatMessage, context: LiveChatEntry[]) {
  if (config.replyMode !== "addressed") return true;
  const text = message.text.toLocaleLowerCase();
  const nickname = (config.nickname || "助手").trim().toLocaleLowerCase();
  const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = nickname && (/[\u3400-\u9fff]/.test(nickname) ? text.includes(nickname) : new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text));
  if (named || /\b(?:bot|assistant)\b|助手/.test(text)) return true;
  if (/@[\p{L}\p{N}_-]+/u.test(text)) return false;
  return context.some(entry => entry.authorId === message.authorId && entry.status === "sent" && message.publishedAt - entry.at >= 0 && message.publishedAt - entry.at < 60_000) && /^(?:(?:why|how|what|and|but|yes|no|thanks|thank you)\b|为什么|那|但是|谢谢|嗯)/i.test(text);
}

/** 明确英文发问（即使引用中文词）不应回成中文；其他混合语言保留模型判断。 */
export function wrongReplyLanguage(input: string, reply: string) {
  const english = !/[\u3400-\u9fff]/.test(input) && /[a-z]{2}/i.test(input) || /^(?:what (?:is|does)|how (?:do|does|can)|can you|why is)\b/i.test(input.trim());
  const answer = reply.replace(/[“「『"'][^”」』"']*[”」』"']/g, "");
  return english && /[\u3400-\u9fff]/.test(answer) && !/[a-z]{2}/i.test(answer);
}
