/** 显式运行的付费离线质量评估：仅合成留言，不连接 YouTube，不输出密钥或原始异常。 */
import { mkdir, writeFile } from "node:fs/promises";
import { generateLiveChatDecision } from "../src/core/live-chat-ai";
import { Store } from "../src/core/storage";
import { defaultLiveChatConfig, type LiveChatEntry } from "../src/shared/live-chat";
import { chatPersonas, type ChatPersona } from "../src/shared/chat-personas";

/** 八个人设双语样本和连续截图场景；失败仅保存安全标记以供人工评审。 */
async function main() {
  const rows: unknown[] = [];
  const store = new Store(".data/chat-evaluation");
  const base = { ...defaultLiveChatConfig, replyMode: "responsive" as const, channelFacts: "本直播间播放 AI 生成音乐，当前音乐未命名。" };
  /** 使用合成观众调用真实生成器，历史最多限于当前离线场景。 */
  async function sample(preset: ChatPersona, text: string, history: LiveChatEntry[] = []) {
    try {
      const result = await generateLiveChatDecision(store, { ...base, preset }, { id: "sample", authorId: "synthetic", author: "viewer", text, firstMessage: !history.length, publishedAt: Date.now(), type: "textMessageEvent" }, history, AbortSignal.timeout(50_000));
      rows.push({ preset, text, ...result });
      history.push({ id: String(history.length), authorId: "synthetic", author: "viewer", text, reply: result.reply, status: result.action === "skip" ? "skipped" : "sent", at: Date.now() });
    } catch { rows.push({ preset, text, error: "Generation failed; no upstream details recorded." }); }
  }
  for (const preset of Object.keys(chatPersonas).filter(key => key !== "custom") as ChatPersona[]) {
    await Promise.all([sample(preset, "好好听呀"), sample(preset, "I’m still doing homework")]);
    console.log(`Evaluated ${preset}`);
  }
  const history: LiveChatEntry[] = [];
  for (const text of ["hi", "这是什么歌曲呀", "好好听呀", "I like it", "what is 谈何", "asdfghjkl", "你是人吗"]) await sample("friendly", text, history);
  await mkdir(".data/chat-evaluation", { recursive: true });
  await writeFile(".data/chat-evaluation/results.json", JSON.stringify({ at: new Date().toISOString(), synthetic: true, realModel: true, youtubeSent: false, rows }, null, 2));
  console.log("Results saved to .data/chat-evaluation/results.json");
}
void main();
