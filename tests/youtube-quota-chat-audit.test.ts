/** 配额审计：通过真实聊天运行器量化重连与发送上限，所有消息、存储和网络均为 Mock。 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/core/storage";
import { LiveChatRunner } from "../src/core/live-chat/runner";
import { AppError } from "../src/core/errors";
import type { LiveChatBatch, LiveChatPorts } from "../src/shared/live-chat";
import { defaultLiveChatConfig } from "../src/shared/live-chat";

class MemoryStore extends Store {
  files = new Map<string, unknown>();
  /** 读取独立副本，不访问安装版目录。 */
  override async read<T>(name: string): Promise<T | null> { return this.files.has(name) ? structuredClone(this.files.get(name)) as T : null; }
  /** 保留真实加密检查点，底层仅写测试内存。 */
  override async write(name: string, value: unknown) { this.files.set(name, structuredClone(value)); }
}
const runners: LiveChatRunner[] = [];
const measurements: { scenario: string; calls: number; offsetsMs: number[] }[] = [];
/** 仅显式审计命令导出脱敏计数；常规 CI 不额外生成交付文件。 */
afterAll(async () => { if (process.env.QUOTA_AUDIT_OUTPUT) { const file = path.resolve(process.env.QUOTA_AUDIT_OUTPUT); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(measurements, null, 2)); } });
/** 使用可控时钟与有效合成凭据保护测试，任何真实 fetch 都视为审计失败。 */
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T12:00:00Z")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network forbidden"); })); });
/** 等待真实运行器排空取消与检查点后恢复全局时钟。 */
afterEach(async () => { for (const runner of runners.splice(0)) await runner.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** 一个流可保持连接、无批次报错，或收到空批次后立即结束；记录每次实际 StreamList 调用时间。 */
function fixture(mode: "stable" | "empty-eof" | "network" | "quota") {
  const attempts: number[] = []; const sent: number[] = [];
  let push: ((batch: LiveChatBatch) => void) | undefined;
  const ports: LiveChatPorts = {
    configured: async () => true,
    observe: vi.fn(async () => ({ channelId: "channel", broadcastId: "broadcast", liveChatId: "chat", live: true, available: true })),
    /** 运行器调用次数就是真实 gRPC 方法的调用次数，不按响应批次数计费。 */
    stream: async function* (_id, _cursor, signal) {
      attempts.push(Date.now());
      if (mode === "network") throw new AppError("CHAT_NETWORK", "synthetic");
      if (mode === "quota") throw new AppError("CHAT_QUOTA", "synthetic");
      if (mode === "empty-eof") { yield { messages: [], nextPageToken: "synthetic-cursor" }; return; }
      while (!signal.aborted) {
        const batch = await new Promise<LiveChatBatch | undefined>(resolve => {
          const stop = () => { push = undefined; resolve(undefined); };
          signal.addEventListener("abort", stop, { once: true });
          push = value => { signal.removeEventListener("abort", stop); push = undefined; resolve(value); };
        });
        if (batch) yield batch;
      }
    },
    generate: async () => "Synthetic reply",
    send: vi.fn(async () => { sent.push(Date.now()); return { id: "sent-" + sent.length }; }),
    now: () => Date.now(),
  };
  const runner = new LiveChatRunner(new MemoryStore("synthetic"), ports); runners.push(runner);
  return { runner, ports, attempts, sent, push: (batch: LiveChatBatch) => { if (!push) throw new Error("Feed not ready"); push(batch); } };
}
it("100 repeated starts do not duplicate a stable stream, and stop prevents later reconnects", async () => {
  const f = fixture("stable"); for (let i = 0; i < 100; i++) f.runner.start();
  await vi.advanceTimersByTimeAsync(60_000); expect(f.attempts).toHaveLength(1);
  await f.runner.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(f.attempts).toHaveLength(1);
});
it("an empty batch followed by EOF resets the failure count and repeatedly returns to short reconnect delay", async () => {
  const f = fixture("empty-eof"); f.runner.start(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.attempts.length).toBeGreaterThan(30);
  const gaps = f.attempts.slice(1).map((at, i) => at - f.attempts[i]);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1500);
  measurements.push({ scenario: "empty-batch-eof-60s", calls: f.attempts.length, offsetsMs: f.attempts.map(at => at - f.attempts[0]) });
  console.log("QUOTA_AUDIT empty-batch-eof 60s calls=" + f.attempts.length + " gapsMs=" + [...new Set(gaps)].join(","));
});
it("network failures without a successful batch do increase backoff", async () => {
  const f = fixture("network"); f.runner.start(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.attempts.length).toBeLessThanOrEqual(7);
  measurements.push({ scenario: "no-batch-network-60s", calls: f.attempts.length, offsetsMs: f.attempts.map(at => at - f.attempts[0]) });
  console.log("QUOTA_AUDIT no-batch-network 60s calls=" + f.attempts.length + " offsetsMs=" + f.attempts.map(at => at - f.attempts[0]).join(","));
});
it("explicit chat quota errors persist a midnight block even across credentials refresh and reconfiguration", async () => {
  const f = fixture("quota"); f.runner.start(); await vi.advanceTimersByTimeAsync(1000);
  await f.runner.keyChanged(); await f.runner.configure(defaultLiveChatConfig); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.attempts).toHaveLength(1); expect((await f.runner.status()).state).toBe("quota_wait");
  measurements.push({ scenario: "explicit-quota-61s", calls: f.attempts.length, offsetsMs: [0] });
});
it("a full queue permits 12 sends in one minute with the default five-second interval", async () => {
  const f = fixture("stable"); f.runner.start(); await vi.advanceTimersByTimeAsync(600);
  f.push({ messages: Array.from({ length: 100 }, (_, i) => ({ id: "m-" + i, authorId: "viewer-" + i, author: "Synthetic", text: "message-" + i, type: "textMessageEvent", publishedAt: Date.now() })) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.sent).toHaveLength(12); expect(f.attempts).toHaveLength(1);
  measurements.push({ scenario: "default-send-rate-60s", calls: f.sent.length, offsetsMs: f.sent.map(at => at - f.sent[0]) });
  console.log("QUOTA_AUDIT default-send-rate 60s sends=" + f.sent.length + " nominalUnits=" + f.sent.length * 20);
});
