/** 用真实 Service 和模拟聊天端口验证停止态、迟到缓存及凭据恢复；不启动 OBS 或外部网络。 */
import { beforeEach, expect, it, vi } from "vitest";
import type { LiveChatPorts } from "@/shared/live-chat";
const wiring = vi.hoisted(() => ({ ports: undefined as LiveChatPorts | undefined, keyChanged: vi.fn() }));
vi.mock("@/core/live-chat/runner", () => ({ LiveChatRunner: class {
  /** 捕获 Service 实际注入的观察端口，测试运行器与服务之间的真实契约。 */
  constructor(_store: unknown, ports: LiveChatPorts) { wiring.ports = ports; }
  keyChanged = wiring.keyChanged;
} }));
import { Service } from "@/core/service";
let app: Service;
let phase: "live" | "stopped" | "stopping" | "idle" = "live";
/** 所有 I/O 为合成对象；构造服务本身不会启动进程或进行 HTTP 请求。 */
beforeEach(() => {
  vi.clearAllMocks(); phase = "live"; app = new Service("main");
  vi.spyOn(app.auth, "tokens").mockResolvedValue({ accessToken: "synthetic", refreshToken: "synthetic", channelId: "owner", channel: "fixture", expiresAt: Date.now() + 60_000 });
  vi.spyOn(app.control, "state").mockImplementation(async () => ({ phase, stage: "fixture", broadcastId: "broadcast", updatedAt: new Date().toISOString() }));
  vi.spyOn(app.youtube, "broadcast").mockResolvedValue({ id: "broadcast", snippet: { title: "fixture", liveChatId: "chat" }, status: { lifeCycleStatus: "live" } });
});
it.each(["idle", "stopped", "stopping"] as const)("never resumes chat in %s even if YouTube has an old live result", async next => {
  expect(await wiring.ports!.observe()).toMatchObject({ live: true, liveChatId: "chat" }); phase = next;
  expect(await wiring.ports!.observe()).toMatchObject({ live: false }); expect(app.youtube.broadcast).toHaveBeenCalledOnce();
});
it("rejects a live result that arrives after the local stop completed", async () => {
  let resolve!: (value: Awaited<ReturnType<Service["youtube"]["broadcast"]>>) => void;
  vi.mocked(app.youtube.broadcast).mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  const pending = wiring.ports!.observe(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  phase = "stopped"; app.invalidate(); resolve({ id: "broadcast", snippet: { title: "fixture", liveChatId: "chat" }, status: { lifeCycleStatus: "live" } });
  expect(await pending).toMatchObject({ live: false });
  phase = "live"; await wiring.ports!.observe(); expect(app.youtube.broadcast).toHaveBeenCalledTimes(2);
});
it("coalesces overlapping chat observations and caches the broadcast within 30 seconds", async () => {
  await Promise.all([wiring.ports!.observe(), wiring.ports!.observe()]); await wiring.ports!.observe(); expect(app.youtube.broadcast).toHaveBeenCalledOnce();
});
it("notifies chat after a credentials update and keeps successful saving independent of a corrupt chat checkpoint", async () => {
  wiring.keyChanged.mockRejectedValue(new Error("synthetic private diagnostic"));
  await expect(app.refreshChatCredentials()).resolves.toBeUndefined(); expect(wiring.keyChanged).toHaveBeenCalledOnce();
});
