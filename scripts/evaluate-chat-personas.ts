/** 显式付费的人设质量评估：使用真实生成器与合成留言，不实例化直播运行器、不发送消息或修改用户配置。 */
import { mkdir, writeFile } from "node:fs/promises";
import { generateLiveChatDecision } from "../src/core/live-chat-ai";
import { Store } from "../src/core/storage";
import { isAppError } from "../src/core/errors";
import { defaultLiveChatConfig, type LiveChatConfig } from "../src/shared/live-chat";
import { chatPersonas, type ChatPersona } from "../src/shared/chat-personas";

const facts = "本直播间播放 AI 生成音乐。当前播放的音乐未命名，没有已知可搜索的正式歌名或公开检索链接。";
const customPrompt = "唱片店老板：口语、懒洋洋的幽默，偶尔用唱片店意象，不每句提唱片，不装作知道歌名，不推销。";
const scenarios = [
  { scenario: "song", text: "这首歌叫什么？哪里能搜到？" },
  { scenario: "typo", text: "what is 谈何" },
  { scenario: "nonsense", text: "阿巴阿巴，土豆在月亮上游泳哈哈哈" },
  { scenario: "praise", text: "好好听啊，越听越上头" },
];
const edges = [
  { scenario: "clear-typo", text: "这歌好艇啊" },
  { scenario: "definition", text: "谈何容易是什么意思？" },
  { scenario: "noise", text: "asdfghjkl" },
  { scenario: "unknown-song", text: "这首歌叫什么？", channelFacts: "" },
];
type Sample = { scenario: string; text: string; channelFacts?: string };

/** 按原样保留每个生成结果；生成错误使整轮退出失败，不把人工评分伪装成自动断言。 */
async function main() {
  const focus = process.argv.includes("--focus");
  const directory = `.data/chat-persona-evaluation/${Date.now()}`;
  const storage = new Store(directory);
  const rows: unknown[] = [];
  let failures = 0;
  await mkdir(directory, { recursive: true });
  const presets = (focus ? ["friendly", "gentle", "poetic"] : Object.keys(chatPersonas)) as ChatPersona[];
  const jobs = presets.flatMap(preset => (focus ? scenarios : [...scenarios, ...(["friendly", "gentle", "poetic"].includes(preset) ? edges : [])]).map(input => ({ preset, input })));
  /** 每条使用空历史和相同背景；未知来源边界样本明确清空背景，凭据仅从运行时环境读取。 */
  async function sample(preset: ChatPersona, input: Sample) {
    const config: LiveChatConfig = { ...defaultLiveChatConfig, preset, replyMode: "responsive", channelFacts: input.channelFacts ?? facts, customPrompt: preset === "custom" ? customPrompt : "" };
    try {
      const result = await generateLiveChatDecision(storage, config, { id: "sample", authorId: "synthetic", author: "试聊观众", text: input.text, firstMessage: true, publishedAt: Date.now(), type: "textMessageEvent" }, [], AbortSignal.timeout(50_000));
      const row = { preset, name: chatPersonas[preset].name, ...input, result };
      rows.push(row); console.log(JSON.stringify(row));
    } catch (error) { failures++; const row = { preset, ...input, error: isAppError(error) ? error.code : "EVALUATION_FAILED", issue: isAppError(error) ? error.message : "Evaluation failed." }; rows.push(row); console.log(JSON.stringify(row)); }
  }
  for (let i = 0; i < jobs.length; i += 2) await Promise.all(jobs.slice(i, i + 2).map(job => sample(job.preset, job.input)));
  await writeFile(`${directory}/results.json`, JSON.stringify({ at: new Date().toISOString(), syntheticMessages: true, realModel: true, installedAgent: false, youtubeSent: false, channelFacts: facts, customPrompt, failures, rows }, null, 2));
  console.log(JSON.stringify({ done: true, count: rows.length, failures, path: `${directory}/results.json` }));
  if (failures) process.exitCode = 1;
}
void main().catch(() => { console.error("Evaluation failed; no upstream details recorded."); process.exitCode = 1; });
