/** 模拟聊天 API 的客户归属、能力检查、受限输入和密钥输出，不访问真实 Agent。 */
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/live-chat/route";
import { authenticate, requireAdmin } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { rpc, requireLiveChat } from "@/server/remote";
import { service } from "@/server/service";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
const mode = vi.hoisted(() => ({ cloud: true }));
vi.mock("@/server/http", () => ({ guard: vi.fn(), failed: (error: AppError) => Response.json({ error: error.message }, { status: error.status || 500 }) }));
vi.mock("@/server/access", () => ({ authenticate: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/server/ownership", () => ({ authorizeAgent: vi.fn() }));
vi.mock("@/server/remote", () => ({ cloudMode: () => mode.cloud, target: (value: unknown) => value, rpc: vi.fn(), requireLiveChat: vi.fn() }));
vi.mock("@/server/service", () => ({ service: vi.fn() }));
vi.mock("@/core/audit", () => ({ audit: vi.fn() }));
/** 所有测试默认已登录合成客户与已配置的新 Agent。 */
beforeEach(() => {
  vi.resetAllMocks(); mode.cloud = true;
  vi.mocked(authenticate).mockResolvedValue({ username: "customer", role: "customer" } as Awaited<ReturnType<typeof authenticate>>);
  vi.mocked(rpc).mockResolvedValue({ config: defaultLiveChatConfig, configured: false, state: "needs_key", message: "等待配置", sent: 0, skipped: 0, queued: 0, recent: [], updatedAt: 1 });
});
/** 构造本地 JSON 请求；Key 均为合成值。 */
function request(extra: Record<string, unknown> = {}) {
  return new Request("http://127.0.0.1/api/live-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", agentId: "studio", instanceId: "main", ...extra }) });
}
it("rejects unauthenticated requests before targeting an Agent", async () => {
  vi.mocked(authenticate).mockRejectedValue(new AppError("AUTH", "请登录", 401));
  expect((await POST(request())).status).toBe(401); expect(rpc).not.toHaveBeenCalled();
});
it("rejects another customer's device before capability or task delivery", async () => {
  vi.mocked(authorizeAgent).mockRejectedValue(new AppError("FORBIDDEN", "无权操作", 403));
  expect((await POST(request())).status).toBe(403); expect(requireLiveChat).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});
it("rejects an old or stale Agent before queueing new task kinds", async () => {
  vi.mocked(requireLiveChat).mockRejectedValue(new AppError("CONFIG", "请升级", 409));
  expect((await POST(request())).status).toBe(409); expect(rpc).not.toHaveBeenCalled();
});
it("preserves instance routing for independent live configuration", async () => {
  const config = { ...defaultLiveChatConfig, enabled: false, preset: "gentle", intervalSeconds: 12 };
  expect((await POST(request({ action: "configure", instanceId: "second", config }))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ agentId: "studio", instanceId: "second" }), "customer", { kind: "live-chat-configure", config });
});
it("rejects arbitrary task fields and intervals outside 5 to 60 seconds", async () => {
  expect((await POST(request({ action: "configure", config: { ...defaultLiveChatConfig, intervalSeconds: 1 } }))).status).toBe(400);
  expect((await POST(request({ shell: "fixture" }))).status).toBe(400); expect(rpc).not.toHaveBeenCalled();
});
it("rejects browser key submission and strips private fields from chat status", async () => {
  expect((await POST(request({ action: "key", apiKey: "sk-" + "x".repeat(32) }))).status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  vi.mocked(rpc).mockResolvedValue({ config: defaultLiveChatConfig, configured: true, state: "running", message: "fixture", sent: 0, skipped: 0, queued: 0, recent: [], updatedAt: 1, apiKey: "SECRET", accessToken: "SECRET" });
  const response = await POST(request()); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("SECRET");
});
it("lets administrators assist through the same audited target route", async () => {
  vi.mocked(authenticate).mockResolvedValue({ username: "admin", role: "admin" } as Awaited<ReturnType<typeof authenticate>>);
  expect((await POST(request({ action: "configure", config: defaultLiveChatConfig }))).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ agentId: "studio", instanceId: "main" }), "admin", expect.objectContaining({ kind: "live-chat-configure" }));
  expect(audit).toHaveBeenCalledWith("admin", "live-chat-configure", "main", "succeeded", "studio");
});
it("keeps local mode administrator-only and avoids Cloud RPC", async () => {
  mode.cloud = false;
  vi.mocked(requireAdmin).mockImplementation(() => { throw new AppError("FORBIDDEN", "需要管理员", 403); });
  expect((await POST(request())).status).toBe(403); expect(service).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});
