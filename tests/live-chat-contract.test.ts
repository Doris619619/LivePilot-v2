/** 校验新旧心跳兼容、配置范围及公开聊天字段的白名单边界。 */
import { expect, it } from "vitest";
import { defaultLiveChatConfig, liveChatConfigSchema, liveChatStatusSchema } from "@/shared/live-chat";
import { dashboardSchema } from "@/shared/remote-validation";
import { taskPayloadSchema } from "@/shared/remote";
const dashboard = { busy: false, state: { phase: "idle", stage: "fixture", updatedAt: "fixture" }, obs: { ready: false, running: false, streaming: null }, youtube: { connected: false }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "private", madeForKids: false } };
const chat = { config: defaultLiveChatConfig, configured: false, state: "needs_key", message: "等待配置", sent: 0, skipped: 0, queued: 0, recent: [], updatedAt: 1 };
it("retains old Agent heartbeats without asserting chat support", () => {
  const result = dashboardSchema.parse(dashboard); expect(result.liveChat).toBeUndefined(); expect(result.configuration.liveChat).toBeUndefined();
});
it("accepts optional chat capability and strips unknown private fields", () => {
  const result = dashboardSchema.parse({ ...dashboard, configuration: { ...dashboard.configuration, liveChat: true }, liveChat: { ...chat, accessToken: "SECRET", recent: [{ id: "message", author: "guest", text: "你好", status: "sent", reply: "[AI] 欢迎", at: 1, apiKey: "SECRET" }] } });
  expect(result.configuration.liveChat).toBe(true); expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("enforces bounded status records and allowed remote task input", () => {
  expect(liveChatStatusSchema.safeParse({ ...chat, queued: 101 }).success).toBe(false);
  expect(taskPayloadSchema.safeParse({ kind: "live-chat-configure", config: { ...defaultLiveChatConfig, shell: "fixture" } }).success).toBe(false);
  expect(liveChatConfigSchema.parse({})).toMatchObject({ enabled: true, preset: "friendly", intervalSeconds: 5 });
});
