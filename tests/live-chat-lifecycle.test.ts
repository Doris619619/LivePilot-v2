/** 验证单机聊天由服务进程启动且热重载不重复启动，构建和 Edge 不执行后台业务。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ apps: ["main", "second"].map(id => ({ id, chat: { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) } })), service: vi.fn(), scheduler: vi.fn() }));
vi.mock("@/core/config", () => ({ instanceIds: () => ["main", "second"] }));
vi.mock("@/core/service", () => ({ service: state.service }));
vi.mock("@/cloud/publishing", () => ({ startPublishingScheduler: state.scheduler }));
/** 隔离模块缓存和全局热重载注册表；不创建真实 Service 或进程监听器。 */
beforeEach(() => {
  vi.clearAllMocks(); vi.resetModules();
  delete (globalThis as typeof globalThis & { livePilotLocalChat?: unknown }).livePilotLocalChat;
  state.service.mockImplementation(id => state.apps.find(app => app.id === id));
  vi.spyOn(process, "once").mockReturnValue(process);
});
afterEach(() => { delete (globalThis as typeof globalThis & { livePilotLocalChat?: unknown }).livePilotLocalChat; vi.unstubAllEnvs(); });
it("starts every local instance once independently of any browser request", async () => {
  const { startLocalChat } = await import("@/server/local-chat"); startLocalChat(); startLocalChat();
  expect(state.service.mock.calls.map(call => call[0])).toEqual(["main", "second"]);
  for (const app of state.apps) expect(app.chat.start).toHaveBeenCalledOnce();
});
it("registers process exits that stop both instance runners", async () => {
  const { startLocalChat } = await import("@/server/local-chat"); startLocalChat();
  const stop = vi.mocked(process.once).mock.calls.find(call => call[0] === "SIGTERM")?.[1];
  expect(stop).toBeTypeOf("function"); stop!();
  for (const app of state.apps) expect(app.chat.stop).toHaveBeenCalledOnce();
});
it.each(["edge", undefined])("does not boot chat in runtime %s", async runtime => {
  vi.stubEnv("NEXT_RUNTIME", runtime); vi.stubEnv("LIVEPILOT_MODE", "local");
  const { register } = await import("@/instrumentation"); await register();
  expect(state.service).not.toHaveBeenCalled(); expect(state.scheduler).not.toHaveBeenCalled();
});
it("does not boot chat while generating production build output", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", "phase-production-build");
  const { register } = await import("@/instrumentation"); await register(); expect(state.service).not.toHaveBeenCalled();
});
it("boots local chat at Node service startup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", undefined); vi.stubEnv("LIVEPILOT_MODE", "local");
  const { register } = await import("@/instrumentation"); await register(); expect(state.service).toHaveBeenCalledTimes(2); expect(state.scheduler).not.toHaveBeenCalled();
});
it("boots only the existing Cloud scheduler in Cloud mode", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", undefined); vi.stubEnv("LIVEPILOT_MODE", "cloud");
  const { register } = await import("@/instrumentation"); await register(); expect(state.scheduler).toHaveBeenCalledOnce(); expect(state.service).not.toHaveBeenCalled();
});
