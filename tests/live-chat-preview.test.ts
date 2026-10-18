/** 隔离试聊的收费调用与并发边界；不读取生产 Key，也不创建直播发送端口。 */
import { afterEach, expect, it, vi } from "vitest";
import { LiveChatPreview } from "@/core/live-chat-preview";
import { Store } from "@/core/storage";
import { generateLiveChatDecision } from "@/core/live-chat-ai";
import { defaultLiveChatConfig } from "@/shared/live-chat";
vi.mock("@/core/live-chat-ai", () => ({ generateLiveChatDecision: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
it("uses only supplied synthetic history and rejects concurrent previews", async () => {
  const preview = new LiveChatPreview(new Store("synthetic"));
  let resolve!: (value: { action: "reply"; reply: string; reason: "conversation" }) => void;
  vi.mocked(generateLiveChatDecision).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const input = { config: defaultLiveChatConfig, text: "hi", history: [{ text: "hello", reply: "welcome" }] };
  const pending = preview.run(input);
  await expect(preview.run(input)).rejects.toMatchObject({ code: "CHAT_RATE" });
  expect(generateLiveChatDecision).toHaveBeenCalledWith(expect.any(Store), input.config, expect.objectContaining({ firstMessage: false }), [expect.objectContaining({ authorId: "preview", text: "hello" })], expect.any(AbortSignal));
  resolve({ action: "reply", reply: "hey", reason: "conversation" });
  expect(await pending).toMatchObject({ reply: "hey" });
});
