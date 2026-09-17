/** 使用隔离存储验证真实密码派生、会话撤销与登录边界，不触及成员真实数据。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accessStore, authenticate, digest, emptyAccess, login, logout, passwordHash, SESSION_COOKIE } from "@/server/access";
import { POST as session } from "@/app/api/session/route";
import { GET as instances } from "@/app/api/instances/route";
import { config } from "@/server/config";
let root: string;
/** 每个测试创建独立账户存储；不使用 .env.local 或现有会话。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "livepilot-access-")); vi.stubEnv("LIVEPILOT_ACCESS_DIR", root); vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010");
  const state = emptyAccess(); state.users.push({ username: "alice", salt: "b".repeat(32), hash: (await passwordHash("test-password-123", "b".repeat(32))).toString("hex"), revision: "one", disabled: false });
  await accessStore().write("access.json", state);
});
/** 清理仅限本测试创建的临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("livepilot-access-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 构造已登录的本机请求，明文 token 只存在测试内存。 */
function request(token: string) { return new Request("http://127.0.0.1:3010/api/instances", { headers: { host: "127.0.0.1:3010", cookie: SESSION_COOKIE + "=" + token } }); }
it("stores only token digests, authenticates members and revokes logout", async () => {
  const result = await login("alice", "test-password-123");
  expect(await authenticate(request(result.token))).toEqual({ username: "alice" });
  const saved = await accessStore().read("access.json");
  expect(JSON.stringify(saved)).not.toContain(result.token);
  expect(JSON.stringify(saved)).toContain(digest(result.token));
  await logout(request(result.token));
  await expect(authenticate(request(result.token))).rejects.toMatchObject({ status: 401 });
});
it("immediately rejects revoked account revisions and expired sessions", async () => {
  const result = await login("alice", "test-password-123");
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  state.users[0].revision = "two"; await accessStore().write("access.json", state);
  await expect(authenticate(request(result.token))).rejects.toMatchObject({ status: 401 });
  state.users[0].revision = "one"; state.sessions[digest(result.token)].expires = 1; await accessStore().write("access.json", state);
  await expect(authenticate(request(result.token))).rejects.toMatchObject({ status: 401 });
});
it("rejects unauthenticated business reads", async () => {
  expect((await instances(request(""))).status).toBe(401);
});
it("limits repeated invalid credentials without revealing account existence", async () => {
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  state.attempts[digest("alice")] = { count: 10, until: Date.now() + 60000 };
  await accessStore().write("access.json", state);
  await expect(login("alice", "wrong")).rejects.toMatchObject({ status: 429 });
  await expect(login("absent", "wrong")).rejects.toMatchObject({ status: 401, message: "账号或密码不正确。" });
});
it("allows an explicit HTTPS origin and sets Secure session cookies", async () => {
  vi.stubEnv("LIVEPILOT_ORIGIN", "https://live.example.com");
  expect(config().redirectUri).toBe("https://live.example.com/api/youtube/callback");
  const result = await session(new Request("https://live.example.com/api/session", { method: "POST", headers: { host: "live.example.com", origin: "https://live.example.com", "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ username: "alice", password: "test-password-123" }) }));
  expect(result.status).toBe(200); expect(result.headers.get("set-cookie")).toContain("Secure"); expect(result.headers.get("set-cookie")).toContain("HttpOnly");
});
it("does not trust forwarded host to bypass origin checks", async () => {
  const response = await session(new Request("http://127.0.0.1:3010/api/session", { method: "POST", headers: { host: "evil.test", "x-forwarded-host": "127.0.0.1:3010", origin: "http://127.0.0.1:3010", "x-livepilot": "1", "content-type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(403);
});
