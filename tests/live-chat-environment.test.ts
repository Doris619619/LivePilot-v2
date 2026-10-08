/** 合成环境密钥同步验证：白名单、缺省兼容、变更通知及错误无秘密；不访问真实 Cloud 或 AI。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncLiveChatEnvironment } from "@/agent/live-chat-environment";
import type { Service } from "@/core/service";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";

const cloudKey = "synthetic_cloud_deepseek_key";
const agentKey = "synthetic_agent_deepseek_key";

/** 构造只含被调用方法的实例替身，禁止真实 OBS、令牌或聊天操作。 */
function serviceFixture() {
  const refreshChatCredentials = vi.fn().mockResolvedValue(undefined);
  return { service: { refreshChatCredentials } as unknown as Service, refreshChatCredentials };
}

beforeEach(() => { vi.stubEnv("DEEPSEEK_API_KEY", agentKey); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("requests the fixed authenticated Agent endpoint and injects a changed valid key into process env", async () => {
  const first = serviceFixture(); const second = serviceFixture(); const post = vi.fn().mockResolvedValue({ apiKey: cloudKey });
  await expect(syncLiveChatEnvironment({ post }, [first.service, second.service])).resolves.toBeUndefined();
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/agent/live-chat-environment", {}); expect(process.env.DEEPSEEK_API_KEY).toBe(cloudKey);
  expect(first.refreshChatCredentials).toHaveBeenCalledOnce(); expect(second.refreshChatCredentials).toHaveBeenCalledOnce();
});

it("leaves an existing administrator Agent env key untouched when Cloud has no key", async () => {
  const f = serviceFixture(); const post = vi.fn().mockResolvedValue({}); await syncLiveChatEnvironment({ post }, [f.service]);
  expect(process.env.DEEPSEEK_API_KEY).toBe(agentKey); expect(f.refreshChatCredentials).not.toHaveBeenCalled();
});

it("does not invent a key or reset chat when both environments are unconfigured", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", undefined); const f = serviceFixture(); await syncLiveChatEnvironment({ post: vi.fn().mockResolvedValue({}) }, [f.service]);
  expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); expect(f.refreshChatCredentials).not.toHaveBeenCalled();
});

it("avoids canceling active chat when the key is unchanged, including equivalent surrounding whitespace", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", " " + cloudKey + " "); const f = serviceFixture(); const post = vi.fn().mockResolvedValue({ apiKey: cloudKey });
  await syncLiveChatEnvironment({ post }, [f.service]); await syncLiveChatEnvironment({ post }, [f.service]); expect(f.refreshChatCredentials).not.toHaveBeenCalled();
  expect(process.env.DEEPSEEK_API_KEY).toBe(" " + cloudKey + " ");
});

it.each([null, { apiKey: "" }, { apiKey: 123 }, { apiKey: "short" }, { apiKey: "synthetic invalid key" }, { apiKey: cloudKey, token: "synthetic_secret_token" }])("rejects invalid or extra response fields without altering Agent env (%j)", async response => {
  const f = serviceFixture(); await expect(syncLiveChatEnvironment({ post: vi.fn().mockResolvedValue(response) }, [f.service])).rejects.toMatchObject({ code: "CHAT_ENVIRONMENT", message: "AI互动环境暂时不可用，请稍后重试。", status: 503 });
  expect(process.env.DEEPSEEK_API_KEY).toBe(agentKey); expect(f.refreshChatCredentials).not.toHaveBeenCalled();
});

it("replaces raw transport errors with a fixed safe error and never logs secret contents", async () => {
  const logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  const f = serviceFixture(); const diskWrites = vi.spyOn(Store.prototype, "write");
  const failure = new AppError("CLOUD_REQUEST", "raw bootstrap response " + cloudKey + " synthetic_token", 502);
  await expect(syncLiveChatEnvironment({ post: vi.fn().mockRejectedValue(failure) }, [f.service])).rejects.toMatchObject({ code: "CHAT_ENVIRONMENT", message: "AI互动环境暂时不可用，请稍后重试。" });
  expect(logs.every(log => log.mock.calls.length === 0)).toBe(true); expect(diskWrites).not.toHaveBeenCalled(); expect(process.env.DEEPSEEK_API_KEY).toBe(agentKey);
});

it("notifies every instance on a new key even if one refresh fails, and exposes only a fixed failure", async () => {
  const first = serviceFixture(); const second = serviceFixture(); first.refreshChatCredentials.mockRejectedValue(new Error("raw instance token " + cloudKey));
  await expect(syncLiveChatEnvironment({ post: vi.fn().mockResolvedValue({ apiKey: cloudKey }) }, [first.service, second.service])).rejects.toMatchObject({ code: "CHAT_ENVIRONMENT", message: "AI互动环境暂时不可用，请稍后重试。" });
  expect(first.refreshChatCredentials).toHaveBeenCalledOnce(); expect(second.refreshChatCredentials).toHaveBeenCalledOnce(); expect(process.env.DEEPSEEK_API_KEY).toBe(cloudKey);
});

it("never writes the Cloud key into instance storage or returns it to its caller", async () => {
  const f = serviceFixture(); const diskWrites = vi.spyOn(Store.prototype, "write"); const result = await syncLiveChatEnvironment({ post: vi.fn().mockResolvedValue({ apiKey: cloudKey }) }, [f.service]);
  expect(result).toBeUndefined(); expect(diskWrites).not.toHaveBeenCalled();
});

it("removes a previously injected Cloud key when Cloud revokes it and no original Agent key existed", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", undefined); const f = serviceFixture(); const transport = { post: vi.fn().mockResolvedValueOnce({ apiKey: cloudKey }).mockResolvedValue({}) };
  await syncLiveChatEnvironment(transport, [f.service]); expect(process.env.DEEPSEEK_API_KEY).toBe(cloudKey); expect(f.refreshChatCredentials).toHaveBeenCalledOnce();
  await syncLiveChatEnvironment(transport, [f.service]); expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); expect(f.refreshChatCredentials).toHaveBeenCalledTimes(2);
  await syncLiveChatEnvironment(transport, [f.service]); expect(f.refreshChatCredentials).toHaveBeenCalledTimes(2);
});

it("restores the original administrator Agent key when Cloud stops providing its override", async () => {
  const f = serviceFixture(); const transport = { post: vi.fn().mockResolvedValueOnce({ apiKey: cloudKey }).mockResolvedValue({}) };
  await syncLiveChatEnvironment(transport, [f.service]); expect(process.env.DEEPSEEK_API_KEY).toBe(cloudKey);
  await syncLiveChatEnvironment(transport, [f.service]); expect(process.env.DEEPSEEK_API_KEY).toBe(agentKey); expect(f.refreshChatCredentials).toHaveBeenCalledTimes(2);
});
