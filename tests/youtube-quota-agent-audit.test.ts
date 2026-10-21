/** Agent 配额审计：Cloud 会话被拒绝时仍运行哪些后台循环；仅计数 Mock 快照，不访问网络。 */
import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ snapshot: vi.fn(async () => ({ instance: { id: "main" }, observedAt: Date.now() })), session: vi.fn(async () => { throw new Error("Synthetic rejected session"); }) }));
vi.mock("@/core/ownership", () => ({ claimHost: vi.fn() }));
vi.mock("../src/agent/transport", () => ({ Transport: class {} }));
vi.mock("../src/agent/session", () => ({ connectSession: calls.session }));
vi.mock("../src/agent/executor", () => ({ Executor: class {
  services = new Map(); snapshot = calls.snapshot;
  /** 测试清理只等待模拟循环，不执行发布或聊天。 */
  stopChat = async () => {};
  stopPublishing = async () => {};
} }));
vi.mock("../src/agent/worker", () => ({ Worker: class {
  problems = new Map();
  /** 故障会话不接收任务，退出只排空模拟工作。 */
  drain = async () => {};
  purgeYouTube = vi.fn();
} }));
import { runAgent } from "../src/agent/runner";
/** 审计完成后恢复时钟及环境；被测循环在断言前已正常退出。 */
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("starts snapshot readers before the Cloud session succeeds and keeps them running during rejection", async () => {
  vi.useFakeTimers(); calls.snapshot.mockClear(); calls.session.mockClear();
  vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010");
  let stopped = false;
  const running = runAgent({ agentId: "synthetic", origin: "http://127.0.0.1:3010", token: "synthetic" }, { stopped: () => stopped });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(calls.session).toHaveBeenCalledTimes(4); expect(calls.snapshot).toHaveBeenCalledTimes(3);
  stopped = true; await vi.advanceTimersByTimeAsync(30_000); await running;
  expect(calls.snapshot).toHaveBeenCalledTimes(3);
});
