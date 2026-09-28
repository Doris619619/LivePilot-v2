/** DeepSeek 测试只用合成 Key 和模拟 HTTP，验证加密、英文输出与错误脱敏。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "@/core/storage";
import { aiStatus, saveAiKey, generateCopy, DEEPSEEK_MODEL } from "@/core/broadcast-ai";
let dir: string; let storage: Store;
const key = "sk-synthetic-key-for-tests-only";
/** 隔离磁盘和加密密钥；所有 HTTP 都由测试控制。 */
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "ai-copy-test-")); storage = new Store(dir); vi.stubEnv("DEEPSEEK_API_KEY", ""); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); });
/** 清理自己创建的临时目录，不读取真实 API Key。 */
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("ai-copy-test-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true }); });
it("encrypts the key, exposes only presence and refuses generation without a key", async () => {
  expect(await aiStatus(storage)).toEqual({ configured: false });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(generateCopy(storage, "lofi")).rejects.toThrow("API Key"); expect(fetcher).not.toHaveBeenCalled();
  expect(await saveAiKey(storage, key)).toEqual({ configured: true });
  expect(await readFile(path.join(dir, "deepseek.enc"), "utf8")).not.toContain(key);
  expect(await aiStatus(storage)).toEqual({ configured: true });
});
it("turns a short style brief into a bounded English JSON request", async () => {
  await saveAiKey(storage, key);
  const copy = { title: "Lofi Rainy Nights | Beats to Study & Relax", description: "Unwind with mellow lofi beats and a calm late-night atmosphere.\n\n#lofi #study" };
  const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(copy) } }] })); vi.stubGlobal("fetch", fetcher);
  expect(await generateCopy(storage, "lofi")).toEqual(copy);
  expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
  const request = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(request).toMatchObject({ model: DEEPSEEK_MODEL, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
  expect(request.messages[1]).toEqual({ role: "user", content: "lofi" }); expect(JSON.stringify(request)).not.toContain(key);
});
it.each([401, 402, 429, 500])("does not expose the upstream error or key on HTTP %s", async status => {
  await saveAiKey(storage, key); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive diagnostic " + key, { status })));
  await expect(generateCopy(storage, "lofi")).rejects.toMatchObject({ code: "AI_REQUEST" });
});
it.each([
  { title: "中文标题", description: "English" }, { title: "x".repeat(101), description: "English" }, { title: "Good", description: "" }, { title: "Good", description: "English", secret: "unexpected" },
])("rejects unusable output without overwriting the draft", async copy => {
  await saveAiKey(storage, key); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(copy) } }] })));
  await expect(generateCopy(storage, "lofi")).rejects.toThrow("原文案已保留");
});

it("uses server environment credentials and gives instance credentials precedence", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-environment-synthetic-only");
  expect(await aiStatus(storage)).toEqual({ configured: true });
  const copy = { title: "Lofi Night", description: "Soft beats for a peaceful night." };
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(copy) } }] })));
  vi.stubGlobal("fetch", fetcher);
  expect(await generateCopy(storage, "lofi")).toEqual(copy);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-environment-synthetic-only");
  await saveAiKey(storage, key);
  await generateCopy(storage, "jazz");
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer " + key);
});
