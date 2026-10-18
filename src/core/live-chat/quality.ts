/** 针对实测中反复出现的留客、赶客和虚构记忆表达进行窄范围复核；不替换文本、不生成固定回复。 */
import type { LiveChatMessage } from "@/shared/live-chat";

/** 命中已知退化表达时要求生成器重写一次；这不是对全部语义或风格的评分器。 */
export function needsConversationRepair(reply: string, message: LiveChatMessage): boolean {
  const greeting = /^(?:hi|hello|hey|你好|嗨|哈喽|晚上好|早上好)[\s!！,.，。~～]*$/iu.test(message.text.trim());
  const directing = /(?:安静听|多(?:待|留)一会|欢迎(?:你|来|进|光临|回来)|keep you company|stay (?:a little|for a) while|just listen quietly)/iu;
  const invented = /(?:我(?:先|得|会|已经)?记(?:下|住)|记(?:下|住)了|记在(?:小本本|本子)上|不(?:只|止)你一个|not just you|I'll remember that)/iu;
  const addedGreeting = /(?:^|[，,！!])(?:晚上好|早上好|你好|hello|hi there)[!。！.\s]*$/iu;
  const musicReaction = /(?:歌|音乐|好听|好艇|music|song)/iu.test(message.text);
  const claimedListening = /(?:我也觉得|我(?:刚|也)?听(?:了|着)|I (?:heard|listened)|sounds (?:good|great) to me)/iu.test(reply);
  const claimedCreation = /(?:(?<!不是|并非|不是由|并非由)(?:我|我们)(?:生成|创作|作曲|编曲)|I (?:made|generated|composed) (?:this|it|the (?:song|music)))/iu.test(reply);
  const sourceQuestion = /(?:什么|哪|谁|名字|歌名|人工智能|生成|\b(?:AI|how|what|name|title|generated|made)\b)/iu.test(message.text);
  const unrelatedSource = !sourceQuestion && /(?:AI[\s-]*(?:生成|generated)|人工智能|未命名|还没(?:有)?(?:起|取)?名字)/iu.test(reply);
  return invented.test(reply) || claimedCreation || unrelatedSource || (musicReaction && claimedListening) || (!greeting && (directing.test(reply) || addedGreeting.test(reply)));
}
