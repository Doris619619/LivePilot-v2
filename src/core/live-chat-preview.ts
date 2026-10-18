/** Agent 内隔离试聊：只调用生成器，不读取直播聊天或修改运行配置，不发送 YouTube。 */
import type { ChatPreviewInput, LiveChatEntry } from "@/shared/live-chat";
import { chatPreviewInputSchema } from "@/shared/live-chat";
import { generateLiveChatDecision } from "./live-chat-ai";
import { AppError } from "./errors";
import type { Store } from "./storage";

export class LiveChatPreview {
  private busy = false;
  private lastAt = 0;
  /** 每实例复用限频状态；构造时不访问模型、文件或直播。 */
  constructor(private storage: Store) {}
  /** 每实例最多一个请求，至少间隔五秒；试聊历史由浏览器显式提交且限定长度。 */
  async run(input: ChatPreviewInput) {
    const parsed = chatPreviewInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError("INPUT", "试聊内容过长或设置无效。");
    if (this.busy || Date.now() - this.lastAt < 5000) throw new AppError("CHAT_RATE", "试聊正在生成或过于频繁，请稍后再试。", 429);
    this.busy = true; this.lastAt = Date.now();
    try {
      const { config, text, history } = parsed.data;
      const context: LiveChatEntry[] = history.map((turn, index) => ({ id: `preview-${index}`, authorId: "preview", author: "试聊观众", text: turn.text, reply: turn.reply, status: turn.reply ? "sent" : "skipped", at: Date.now() }));
      return await generateLiveChatDecision(this.storage, config, { id: "preview-current", authorId: "preview", author: "试聊观众", text, firstMessage: !history.length, publishedAt: Date.now(), type: "textMessageEvent" }, context, AbortSignal.timeout(40_000));
    } finally { this.busy = false; }
  }
}
