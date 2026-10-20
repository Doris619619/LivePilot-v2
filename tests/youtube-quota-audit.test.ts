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

let phase: "live" | "stopped" | "idle"; let withIds: boolean; let failure: "quota" | "network" | undefined;
let fetcher: ReturnType<typeof vi.fn>;
/** 每个测试从全新模拟时钟和计数器开始，任何 fetch 都被替换为内存响应。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  phase = "live"; withIds = true; failure = undefined; wiring.ports.length = 0;
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
  vi.spyOn(app.control, "state").mockImplementation(async () => ({ phase, stage: "Synthetic", ...(withIds ? { broadcastId: "b_" + id, streamId: "s_" + id } : {}), updatedAt: new Date().toISOString() }));
  vi.spyOn(app.commands, "latest").mockResolvedValue(undefined);
  return app;
}
it("counts 360 upstream reads in one ideal hour even after a stream stopped with retained IDs", async () => {
  phase = "stopped"; const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await app.dashboard(); }
  expect(fetcher).toHaveBeenCalledTimes(360);
  console.log("QUOTA_AUDIT stopped-with-ids 1h upstream=360 nominalUnits=360");
});
it("counts 120 channel reads per hour when authorized but no broadcast IDs exist, and zero when unauthenticated", async () => {
  phase = "idle"; withIds = false; const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await app.dashboard(); }
  expect(fetcher).toHaveBeenCalledTimes(120); fetcher.mockClear(); await service("obs_0", false).dashboard(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([1, 10, 50, 100])("scales linearly for %i authorized instances across two TTL windows, with 20 concurrent readers each", async count => {
  const apps = Array.from({ length: count }, (_, i) => service(i ? "obs_" + (i - 1) : "main"));
  for (let round = 0; round < 2; round++) {
    await Promise.all(apps.flatMap(app => Array.from({ length: 20 }, () => app.dashboard())));
    vi.setSystemTime(Date.now() + 30_000);
  }
  expect(fetcher).toHaveBeenCalledTimes(count * 6);
});
it("coalesces chat observations and dashboards but resumes reads at the shared 30-second boundary", async () => {
  const app = service();
  await Promise.all([app.dashboard(), ...Array.from({ length: 50 }, () => wiring.ports[0].observe())]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 59; i++) { vi.setSystemTime(Date.now() + 500); await wiring.ports[0].observe(); }
  expect(fetcher).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 500); await app.dashboard(); expect(fetcher).toHaveBeenCalledTimes(6);
});
it.each(["quota", "network"] as const)("continues %s attempts each 30 seconds with no midnight circuit breaker", async error => {
  failure = error; const app = service(); const start = Date.now();
  for (let second = 0; second < 3600; second += 5) { vi.setSystemTime(start + second * 1000); await Promise.all(Array.from({ length: 10 }, () => app.dashboard())); }
  expect(fetcher).toHaveBeenCalledTimes(120);
  expect((await app.dashboard()).youtube.query).toBe("failed");
});
it("new Service instances lose caches, while ordinary repeated reads preserve them", async () => {
  const app = service(); await app.dashboard(); await app.dashboard(); expect(fetcher).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 9; i++) await service().dashboard(); expect(fetcher).toHaveBeenCalledTimes(30);
});
it("a Cloud reconnect account-environment reset invalidates the live status cache each time", async () => {
  const app = service();
  for (let i = 0; i < 10; i++) { await resetAccountAiEnvironment([app]); await app.dashboard(); }
  expect(fetcher).toHaveBeenCalledTimes(30);
});
