/** 验证新资产与 AI 路由的登录、客户归属及旧 Agent 拒绝边界。 */
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/broadcast-assets/route";
import { authenticate } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { rpc, requireBroadcastDetails } from "@/server/remote";
import { AppError } from "@/core/errors";
vi.mock("@/server/http", () => ({ guard: vi.fn(), failed: (e: AppError) => Response.json({ error: e.message }, { status: e.status || 500 }) }));
vi.mock("@/server/access", () => ({ authenticate: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/server/ownership", () => ({ authorizeAgent: vi.fn() }));
vi.mock("@/server/remote", () => ({ cloudMode: () => true, target: (value: unknown) => value, rpc: vi.fn(), requireBroadcastDetails: vi.fn() }));
/** 默认是已登录客户和支持新功能的目标 Agent，测试逐项收窄权限。 */
beforeEach(() => { vi.resetAllMocks(); vi.mocked(authenticate).mockResolvedValue({ username: "customer", role: "customer" } as Awaited<ReturnType<typeof authenticate>>); vi.mocked(rpc).mockResolvedValue({ title: "Lofi Beats", description: "English description" }); });
/** 构造受控 JSON 请求，不包含真实凭据。 */
function request(body = { action: "ai-generate", agentId: "studio", instanceId: "main", brief: "lofi" }) { return new Request("http://127.0.0.1/api/broadcast-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
it("rejects unauthenticated requests before contacting an Agent", async () => {
  vi.mocked(authenticate).mockRejectedValue(new AppError("AUTH", "请登录", 401)); expect((await POST(request())).status).toBe(401); expect(rpc).not.toHaveBeenCalled();
});
it("rejects another customer's device before sending a style brief", async () => {
  vi.mocked(authorizeAgent).mockRejectedValue(new AppError("FORBIDDEN", "无权操作", 403)); expect((await POST(request())).status).toBe(403); expect(rpc).not.toHaveBeenCalled();
});
it("rejects an old Agent before queueing new task kinds", async () => {
  vi.mocked(requireBroadcastDetails).mockRejectedValue(new AppError("CONFIG", "请升级 Agent", 409)); expect((await POST(request())).status).toBe(409); expect(rpc).not.toHaveBeenCalled();
});
it("sends the brief to the assigned instance and returns public copy only", async () => {
  const response = await POST(request()); expect(response.status).toBe(200); expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ agentId: "studio", instanceId: "main" }), "customer", { kind: "broadcast-ai-generate", brief: "lofi" });
  expect(await response.json()).toEqual({ title: "Lofi Beats", description: "English description" });
});
