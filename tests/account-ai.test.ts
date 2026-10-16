/** 合成账号验证密钥隔离、加密、用途执行和配置包，不调用真实 AI 或直播。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "@/app/api/account-ai/route";
import { authenticate } from "@/server/access";
import { accountAiEnvironment } from "@/server/account-ai";
import { setAccountAiRuntime, accountAiRuntime } from "@/core/account-ai-runtime";
import { syncLiveChatEnvironment } from "@/agent/live-chat-environment";
import { requestAi, saveAiKey } from "@/core/broadcast-ai";
import { liveChatAiConfigured, generateLiveChatReply } from "@/core/live-chat-ai";
import { Store } from "@/core/storage";
import type { Service } from "@/core/service";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { defaultBroadcast } from "@/shared/broadcast";
import { applyBroadcastOptions, broadcastOptionsSnapshot, broadcastOptionsSignature } from "@/shared/broadcast-options";
vi.mock("@/server/access", async original => ({ ...await original<typeof import("@/server/access")>(), authenticate: vi.fn() }));
let root: string;
const origin = "http://127.0.0.1:3010", key = "synthetic_account_ai_key";
/** 独立临时目录及合成身份，不读取用户已有密钥。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "account-ai-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "c".repeat(64)); vi.mocked(authenticate).mockResolvedValue({ username: "alice", role: "customer" }); setAccountAiRuntime(undefined); });
/** 只清理本测试创建的路径，恢复进程内策略。 */
afterEach(async () => { setAccountAiRuntime(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("account-ai-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 同源保护走真实路由，模拟用户仅替代登录。 */
function request(body?: unknown, from = origin) { return new Request(origin + "/api/account-ai", { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:3010", origin: from, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

it("encrypts one key per account, never echoes it, preserves blank key and rejects stale writes", async () => {
  expect(await (await GET(request())).json()).toMatchObject({ revision: 0, configured: false });
  const input = { revision: 0, apiKey: key, uses: { copy: true, chat: true } };
  const response = await POST(request(input)); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revision: 1, configured: true, managed: true, uses: input.uses });
  const dir = path.join(root, "account-ai", (await readdir(path.join(root, "account-ai")))[0]);
  expect(await readFile(path.join(dir, "settings.json"), "utf8")).not.toContain(key);
  expect(await accountAiEnvironment("alice")).toMatchObject({ apiKey: key });
  expect((await POST(request({ revision: 1, uses: { copy: false, chat: true } }))).status).toBe(200);
  expect(await accountAiEnvironment("alice")).toMatchObject({ apiKey: key, uses: { copy: false, chat: true } });
  expect((await POST(request(input))).status).toBe(409);
  vi.mocked(authenticate).mockResolvedValue({ username: "bob", role: "customer" });
  expect(await (await GET(request())).json()).toMatchObject({ revision: 0, configured: false });
  expect(await accountAiEnvironment("bob")).toEqual({ managed: false });
});
it("rejects cross-origin, injected owner and invalid key without saving", async () => {
  const input = { revision: 0, apiKey: key, uses: { copy: true, chat: true } };
  expect((await POST(request(input, "https://attacker.invalid"))).status).toBe(403);
  expect((await POST(request({ ...input, username: "bob" }))).status).toBe(400);
  expect((await POST(request({ ...input, apiKey: "short" }))).status).toBe(400);
  expect(await accountAiEnvironment("alice")).toEqual({ managed: false });
});
it("shares account key across copy and chat and never falls back when a use is disabled", async () => {
  const storage = new Store(root); await saveAiKey(storage, "synthetic_old_instance_key");
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic_old_admin_key");
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reply: "[AI] 你好" }) } }] })); vi.stubGlobal("fetch", fetcher);
  setAccountAiRuntime({ apiKey: key, uses: { copy: true, chat: true } });
  await requestAi(storage, "copy", "subject");
  const result = await generateLiveChatReply(storage, defaultLiveChatConfig, { id: "m", authorId: "viewer", author: "小梁", text: "你好", type: "textMessageEvent", publishedAt: 1 }, [], new AbortController().signal);
  expect(result).toBe("@小梁 你好");
  for (const call of fetcher.mock.calls) expect(call[1].headers.Authorization).toBe("Bearer " + key);
  setAccountAiRuntime({ apiKey: key, uses: { copy: false, chat: false } });
  expect(liveChatAiConfigured()).toBe(false);
  await expect(requestAi(storage, "copy", "subject")).rejects.toMatchObject({ code: "CONFIG" });
  await expect(requestAi(storage, "chat", "subject", { keySource: "environment" })).rejects.toMatchObject({ code: "CONFIG" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await storage.read("deepseek.enc")).not.toBeNull();
});
it("syncs account use changes to all runners and retains last policy on a malformed response", async () => {
  const refreshChatCredentials = vi.fn().mockResolvedValue(undefined), service = { refreshChatCredentials } as unknown as Service;
  let enabled = true;
  const post = vi.fn().mockImplementation(async (url: string) => url.includes("account-ai") ? { managed: true, apiKey: key, uses: { copy: true, chat: enabled } } : {});
  await syncLiveChatEnvironment({ post }, [service], true);
  expect(accountAiRuntime()?.apiKey).toBe(key); expect(refreshChatCredentials).toHaveBeenCalledTimes(1);
  enabled = false; await syncLiveChatEnvironment({ post }, [service], true);
  expect(liveChatAiConfigured()).toBe(false); expect(refreshChatCredentials).toHaveBeenCalledTimes(2);
  await expect(syncLiveChatEnvironment({ post: vi.fn().mockResolvedValue({ apiKey: key }) }, [service], true)).rejects.toMatchObject({ code: "CHAT_ENVIRONMENT" });
  expect(accountAiRuntime()?.uses.chat).toBe(false);
});
it("reuses all four chat fields without replacing this broadcast's copy and media", () => {
  const config = { enabled: false, preset: "custom" as const, customPrompt: "简短自然", intervalSeconds: 17 };
  const selection = { video: "a.mp4", music: "b.mp3", videoAudio: false, broadcast: { ...defaultBroadcast(), title: "Current", liveChat: defaultLiveChatConfig } };
  const preset = broadcastOptionsSnapshot({ ...selection, broadcast: { ...selection.broadcast, liveChat: config } });
  expect(preset.broadcast.liveChat).toEqual(config);
  const applied = applyBroadcastOptions(selection, preset);
  expect(applied.broadcast?.liveChat).toEqual(config); expect(applied.video).toBe(selection.video); expect(applied.broadcast?.title).toBe("Current");
  expect(broadcastOptionsSignature(applied)).not.toBe(broadcastOptionsSignature(selection));
});
