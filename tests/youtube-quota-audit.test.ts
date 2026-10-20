/** 配额审计：用真实 Service 与 YouTubeApi 的 Mock HTTP 计数验证缓存、生命周期及实例扩展，不调用 Google。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveChatPorts } from "../src/shared/live-chat";
const wiring = vi.hoisted(() => ({ ports: [] as LiveChatPorts[] }));
vi.mock("@/core/live-chat/runner", () => ({ LiveChatRunner: class {
  /** 保留 Service 注入的真实 observe 闭包，隔离后台运行器和本机文件。 */
  constructor(_store: unknown, ports: LiveChatPorts) { wiring.ports.push(ports); }
  status = async () => undefined;
  keyChanged = async () => {};
} }));
vi.mock("@/core/media", () => ({ scanMedia: async () => ({ videos: [], music: [] }), resolveMedia: vi.fn() }));
import { Service } from "../src/core/service";
import { resetAccountAiEnvironment } from "../src/agent/live-chat-environment";

let phase: "live" | "stopping" | "error" | "stopped" | "idle"; let withIds: boolean; let failure: "quota" | "network" | undefined; let closePending: boolean;
let fetcher: ReturnType<typeof vi.fn>;
/** 每个测试从全新模拟时钟和计数器开始，任何 fetch 都被替换为内存响应。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  phase = "live"; withIds = true; failure = undefined; closePending = false; wiring.ports.length = 0;
  vi.stubEnv("LIVEPILOT_INSTANCES", ["main", ...Array.from({ length: 99 }, (_, i) => "obs_" + i)].join(","));
  fetcher = vi.fn(async (input: string) => {
    if (failure === "network") throw new Error("synthetic offline");
    if (failure === "quota") return Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 });
    const u = new URL(input); const resource = u.pathname.split("/").at(-1);
    if (resource === "channels") return Response.json({ items: [{ id: "channel", snippet: { title: "Synthetic" } }] });
    if (resource === "liveBroadcasts") return Response.json({ items: [{ id: u.searchParams.get("id"), snippet: { title: "Synthetic", liveChatId: "chat" }, status: { lifeCycleStatus: phase === "live" ? "live" : "complete" } }] });
    if (resource === "liveStreams") return Response.json({ items: [{ id: u.searchParams.get("id"), status: { streamStatus: "active" } }] });
    throw new Error("Unexpected synthetic endpoint");
  }); vi.stubGlobal("fetch", fetcher);
});
/** 恢复全局 I/O 与时钟，避免审计计数影响其他回归。 */
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
/** 创建真实服务，只模拟 OBS、令牌与本地状态；YouTube HTTP 仍经过原 API 实现。 */
function service(id = "main", authorized = true) {
  const app = new Service(id);
  const token = { accessToken: "synthetic", refreshToken: "synthetic", channelId: "channel", channel: "Synthetic", expiresAt: Date.now() + 86_400_000 };
  vi.spyOn(app.auth, "tokens").mockResolvedValue(authorized ? token : null);
  vi.spyOn(app.auth, "access").mockResolvedValue(token);
  vi.spyOn(app.obs, "status").mockResolvedValue({ ready: true, running: true, streaming: false });
  vi.spyOn(app.control, "state").mockImplementation(async () => ({ phase, stage: "Synthetic", ...(withIds ? { broadcastId: "b_" + id, streamId: "s_" + id } : {}), ...(closePending ? { stopRequested: true, platformClosePending: true, obsStoppedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() }));
  vi.spyOn(app.commands, "latest").mockResolvedValue(undefined);
  return app;
}
it("makes zero periodic YouTube calls for a full stopped day with retained IDs", async () => {
  phase = "stopped"; const app = service(); const start = Date.now();
  for (let second = 0; second < 86400; second += 5) { vi.setSystemTime(start + second * 1000); await app.dashboard(); }
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["stopping", "error", "stopped"] as const)("pending platform closure in %s never polls or invents a completed YouTube lifecycle", async pendingPhase => {
  phase = pendingPhase; closePending = true; const app = service(); const start = Date.now();
  for (let hour = 0; hour < 24; hour++) { vi.setSystemTime(start + hour * 3600_000); const dashboard = await app.dashboard(); expect(dashboard.youtube.lifecycle).not.toBe("complete"); expect(dashboard.youtube.checkedAt).toBeUndefined(); expect((await wiring.ports[0].observe()).live).toBe(false); }
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not refresh metadata for an idle authorized instance or an unauthenticated instance", async () => {
  phase = "idle"; withIds = false; const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await app.dashboard(); }
  expect(fetcher).not.toHaveBeenCalled(); await service("obs_0", false).dashboard(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([1, 10, 50, 100])("coalesces 20 concurrent readers for %i instances and refreshes only two platform reads after five minutes", async count => {
  const apps = Array.from({ length: count }, (_, i) => service(i ? "obs_" + (i - 1) : "main"));
  for (let round = 0; round < 2; round++) {
    await Promise.all(apps.flatMap(app => Array.from({ length: 20 }, () => app.dashboard())));
    vi.setSystemTime(Date.now() + 300_000);
  }
  expect(fetcher).toHaveBeenCalledTimes(count * 5);
});
it("chat observations share the platform cache and cannot restore the old thirty-second polling", async () => {
  const app = service();
  await Promise.all([app.dashboard(), ...Array.from({ length: 50 }, () => wiring.ports[0].observe())]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 59; i++) { vi.setSystemTime(Date.now() + 500); await wiring.ports[0].observe(); }
  expect(fetcher).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 500); await app.dashboard(); expect(fetcher).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 270_000); await app.dashboard(); expect(fetcher).toHaveBeenCalledTimes(5);
});
it.each(["quota", "network"] as const)("bounds %s failures instead of retrying every thirty seconds", async error => {
  failure = error; const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await Promise.all(Array.from({ length: 10 }, () => app.dashboard())); }
  expect(fetcher).toHaveBeenCalledTimes(error === "quota" ? 1 : 12);
  expect((await app.dashboard()).youtube.query).toBe("failed");
});
it("new Service instances lose caches, while ordinary repeated reads preserve them", async () => {
  const app = service(); await app.dashboard(); await app.dashboard(); expect(fetcher).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 9; i++) await service().dashboard(); expect(fetcher).toHaveBeenCalledTimes(30);
});
it("ordinary Cloud reconnect account-environment resets preserve the platform cache", async () => {
  const app = service();
  for (let i = 0; i < 10; i++) { await resetAccountAiEnvironment([app]); await app.dashboard(); }
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("healthy single-stream polling uses one daily channel read plus two reads every five minutes", async () => {
  const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await app.dashboard(); }
  expect(fetcher).toHaveBeenCalledTimes(25);
  expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/channels"))).toHaveLength(1);
});
