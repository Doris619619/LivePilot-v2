/** Agent 退出与投递竞态：停止后不接收迟到轮询或同批剩余任务，已接收任务仍排空。 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ stopped: false, capabilities: [] as string[], receive: vi.fn(), drain: vi.fn(), poll: vi.fn(), startChat: vi.fn(), stopChat: vi.fn(), syncEnvironment: vi.fn() }));
vi.mock("@/core/config", () => ({ config: () => ({ origin: "https://example.invalid" }), dataRoot: () => "fixture", instanceDescriptors: () => [] }));
vi.mock("@/core/ownership", () => ({ claimHost: vi.fn() }));
vi.mock("@/agent/executor", () => ({ Executor: class { services = new Map(); registerChannels = vi.fn(); connectPublishing = vi.fn(); stopPublishing = vi.fn(); startChat = state.startChat; stopChat = state.stopChat; } }));
vi.mock("@/agent/worker", () => ({ Worker: class { receive = state.receive; drain = state.drain; reports = vi.fn().mockResolvedValue([]); acknowledge = vi.fn(); } }));
vi.mock("@/agent/transport", () => ({ Transport: class { post = vi.fn().mockImplementation(async () => ({ session: "fixture", capabilities: state.capabilities })); request = state.poll; } }));
vi.mock("@/agent/live-chat-environment", () => ({ syncLiveChatEnvironment: state.syncEnvironment }));
import { runAgent } from "@/agent/runner";
import { AppError } from "@/core/errors";
/** 使用合法合成任务，绝不调用真实执行器或控制端。 */
function task() { return { protocol: 1, id: randomUUID(), agentId: "fixture", instanceId: "main", actor: "test", expiresAt: Date.now() + 60_000, payload: { kind: "upload-status", uploadId: randomUUID() } }; }
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.stopped = false; state.capabilities = []; state.drain.mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());
it("does not accept remaining polled tasks after shutdown starts during receipt", async () => {
  state.poll.mockResolvedValue({ json: async () => ({ tasks: [task(), task()] }) });
  state.receive.mockImplementation(async () => { state.stopped = true; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(state.receive).toHaveBeenCalledOnce(); expect(state.drain).toHaveBeenCalledOnce();
  expect(state.startChat).toHaveBeenCalledOnce(); expect(state.stopChat).toHaveBeenCalledOnce();
  expect(state.syncEnvironment).not.toHaveBeenCalled();
  expect(state.stopChat.mock.invocationCallOrder[0]).toBeLessThan(state.drain.mock.invocationCallOrder[0]);
});
it("ignores a late poll response after shutdown without treating it as completed work", async () => {
  state.poll.mockImplementation(async () => { state.stopped = true; return { json: async () => ({ tasks: [task()] }) }; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(state.receive).not.toHaveBeenCalled(); expect(state.drain).toHaveBeenCalledOnce();
});
it("reports trusted error codes for pairing recovery while keeping legacy one-argument hooks compatible", async () => {
  state.poll.mockRejectedValue(new AppError("AGENT_AUTH", "设备凭据失效", 401));
  const error = vi.fn(() => { state.stopped = true; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped, error });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(error).toHaveBeenCalledWith("设备凭据失效", "AGENT_AUTH");
});
it("loads the shared chat environment only when Cloud supports it, before starting chat", async () => {
  state.capabilities = ["live-chat-v1"]; state.syncEnvironment.mockResolvedValue(undefined);
  state.poll.mockImplementation(async () => { state.stopped = true; return { json: async () => ({ tasks: [] }) }; });
  const running = runAgent({ agentId: "fixture", origin: "https://example.invalid", token: "fixture" }, { stopped: () => state.stopped });
  await vi.advanceTimersByTimeAsync(10_000); await running;
  expect(state.syncEnvironment).toHaveBeenCalledOnce(); expect(state.startChat).toHaveBeenCalledOnce();
  expect(state.syncEnvironment.mock.invocationCallOrder[0]).toBeLessThan(state.startChat.mock.invocationCallOrder[0]);
});
