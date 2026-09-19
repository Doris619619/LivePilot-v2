/** Agent 退出与投递竞态：停止后不接收迟到轮询或同批剩余任务，已接收任务仍排空。 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ stopped: false, receive: vi.fn(), drain: vi.fn(), poll: vi.fn() }));
vi.mock("@/core/config", () => ({ config: () => ({ origin: "https://example.invalid" }), dataRoot: () => "fixture", instanceDescriptors: () => [] }));
vi.mock("@/core/ownership", () => ({ claimHost: vi.fn() }));
vi.mock("@/agent/executor", () => ({ Executor: class { registerChannels = vi.fn(); } }));
vi.mock("@/agent/worker", () => ({ Worker: class { receive = state.receive; drain = state.drain; reports = vi.fn().mockResolvedValue([]); acknowledge = vi.fn(); } }));
vi.mock("@/agent/transport", () => ({ Transport: class { post = vi.fn().mockResolvedValue({ session: "fixture" }); request = state.poll; } }));
import { runAgent } from "@/agent/runner";
/** 使用合法合成任务，绝不调用真实执行器或控制端。 */
function task() { return { protocol: 1, id: randomUUID(), agentId: "fixture", instanceId: "main", actor: "test", expiresAt: Date.now() + 60_000, payload: { kind: "upload-status", uploadId: randomUUID() } }; }
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.stopped = false; state.drain.mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());
it("does not accept remaining polled tasks after shutdown starts during receipt", async () => {
  state.poll.mockResolvedValue({ json: async () => ({ tasks: [task(), task()] }) });
  state.receive.mockImplementation(async () => { state.stopped = true; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(state.receive).toHaveBeenCalledOnce(); expect(state.drain).toHaveBeenCalledOnce();
});
it("ignores a late poll response after shutdown without treating it as completed work", async () => {
  state.poll.mockImplementation(async () => { state.stopped = true; return { json: async () => ({ tasks: [task()] }) }; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(state.receive).not.toHaveBeenCalled(); expect(state.drain).toHaveBeenCalledOnce();
});
