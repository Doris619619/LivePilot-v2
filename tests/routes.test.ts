/** HTTP 命令与 OAuth 路由的实例边界测试；服务完全模拟，不触发直播。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as control } from "@/app/api/control/route";
import { POST as connect } from "@/app/api/youtube/connect/route";
import { GET as callback } from "@/app/api/youtube/callback/route";
import { service } from "@/server/service";
import { authenticate } from "@/server/access";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { requireInstance } from "@/server/config";
/** 只模拟路由所需的服务表面，保留独立调用记录。 */
function mockApp(id: string) {
  return {
    commands: { accept: vi.fn(async (input: { requestId: string }) => ({ fresh: true, operation: { id: input.requestId, status: "accepted" } })), run: vi.fn(), withIdle: vi.fn(async (fn: () => Promise<unknown>) => fn()) },
    control: { start: vi.fn(), stop: vi.fn(), launch: vi.fn(), clearUncertain: vi.fn(), exclusive: vi.fn(async (fn: () => Promise<unknown>) => fn()), state: vi.fn(async () => ({ phase: "stopped" })) },
    auth: { begin: vi.fn(async () => ({ cookie: "b".repeat(64), url: "https://accounts.google.com/?state=" + id })), finish: vi.fn() },
    invalidate: vi.fn(),
  };
}
const apps = new Map<string, ReturnType<typeof mockApp>>();
vi.mock("@/server/access", () => ({ authenticate: vi.fn(async () => ({ username: "alice" })) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn() }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/server/service", () => ({ service: vi.fn() }));
/** 每个模拟实例保存自己的调用记录及 OAuth 回调输入。 */
beforeEach(() => {
  vi.stubEnv("LIVEPILOT_INSTANCES", "main,obs_a,studio_c");
  vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010");
  vi.mocked(authenticate).mockResolvedValue({ username: "alice" });
  apps.clear();
  for (const id of ["main", "obs_a", "studio_c"]) {
    apps.set(id, mockApp(id));
  }
  vi.mocked(service).mockImplementation(id => apps.get(requireInstance(id)) as unknown as ReturnType<typeof service>);
});
/** 恢复环境及服务 mock，避免测试之间共享配置。 */
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
/** 构造符合本机同源边界的 JSON 请求。 */
function request(route: string, body: unknown) {
  return new Request("http://127.0.0.1:3010" + route, { method: "POST", headers: { host: "127.0.0.1:3010", origin: "http://127.0.0.1:3010", "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify(route === "/api/control" ? { requestId: randomUUID(), ...(body as object) } : body) });
}
/** stop 必须路由到所选实例，不能隐式操作 main。 */
it("dispatches each command only to the explicit target", async () => {
  for (const id of ["obs_a", "studio_c"]) expect((await control(request("/api/control", { instanceId: id, action: "stop" }))).status).toBe(202);
  expect(apps.get("main")!.commands.accept).not.toHaveBeenCalled();
  expect(apps.get("obs_a")!.commands.accept).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "obs_a", action: "stop" }), "alice");
  expect(apps.get("studio_c")!.commands.accept).toHaveBeenCalledOnce();
  expect(after).toHaveBeenCalled();
});
/** 旧页面或伪造 ID 的写操作必须被拒绝，不猜测目标。 */
it("rejects missing and unknown instance targets", async () => {
  expect((await control(request("/api/control", { action: "start", video: "v", music: "m", videoAudio: false }))).status).toBe(400);
  expect(service).not.toHaveBeenCalled();
  expect((await control(request("/api/control", { instanceId: "../main", action: "stop" }))).status).toBe(400);
});
/** 并行授权使用不同 Cookie 名称，互不覆盖浏览器事务。 */
it("sets an instance-specific OAuth cookie", async () => {
  const result = await connect(request("/api/youtube/connect", { instanceId: "obs_a" }));
  expect(result.status).toBe(200);
  expect(result.headers.get("set-cookie")).toContain("livepilot_oauth_obs_a=");
  expect(result.headers.get("set-cookie")).toContain("HttpOnly");
  expect(apps.get("main")!.auth.begin).not.toHaveBeenCalled();
});
/** 同一个回调 URL 根据已验证 state 定位实例，仅读取该实例 Cookie。 */
it("returns OAuth to its originating panel and reads only its cookie", async () => {
  const response = await callback(new NextRequest("http://127.0.0.1:3010/api/youtube/callback?state=obs_a." + "a".repeat(64) + "&code=fake-code", { headers: { host: "127.0.0.1:3010", cookie: "livepilot_oauth_main=wrong; livepilot_oauth_obs_a=correct" } }));
  expect(response.headers.get("location")).toBe("http://127.0.0.1:3010/?oauth=connected#instance-obs_a");
  expect(apps.get("obs_a")!.auth.finish).toHaveBeenCalledWith("correct", "obs_a." + "a".repeat(64), "fake-code", undefined, "alice");
  expect(apps.get("main")!.auth.finish).not.toHaveBeenCalled();
});
