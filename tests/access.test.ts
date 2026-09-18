/** 使用隔离存储验证真实密码派生、会话撤销与登录边界，不触及成员真实数据。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { accessStore, authenticate, digest, emptyAccess, login, logout, passwordHash, SESSION_COOKIE } from "@/server/access";
import { POST as session } from "@/app/api/session/route";
import { GET as instances } from "@/app/api/instances/route";
import { config } from "@/server/config";
const builtinPassword = "isolated-builtin-test-only";
/** 仅替换测试内的初始摘要；生产内置密码不进入测试或 CI。 */
vi.mock("@/server/builtin-member.json", async () => {
  const { scryptSync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16).toString("hex");
  return { default: { username: "Do", salt, hash: scryptSync("isolated-builtin-test-only", salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex") } };
});
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

/** 内置成员与已有成员共存，HTTP 登录保留大小写且磁盘不保存明文密码。 */
it("seeds Do once and accepts its case-sensitive HTTP login", async () => {
  const result = await session(new Request("http://127.0.0.1:3010/api/session", { method: "POST", headers: { host: "127.0.0.1:3010", origin: "http://127.0.0.1:3010", "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ username: "Do", password: builtinPassword }) }));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ user: { username: "Do" } });
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  expect(state.users.map(u => u.username)).toEqual(["alice", "Do"]);
  expect(JSON.stringify(state)).not.toContain(builtinPassword);
  const revision = state.users[1].revision;
  const next = await login("Do", builtinPassword);
  expect(await authenticate(request(next.token))).toEqual({ username: "Do" });
  const saved = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  expect(saved.users).toHaveLength(2);
  expect(saved.users[1].revision).toBe(revision);
  await expect(login("do", builtinPassword)).rejects.toMatchObject({ status: 401 });
  await expect(login("Do", "incorrect-password")).rejects.toMatchObject({ status: 401 });
});
it("keeps a disabled built-in member disabled and rejects its old session", async () => {
  const initial = await login("Do", builtinPassword);
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  state.users.find(u => u.username === "Do")!.disabled = true;
  await accessStore().write("access.json", state);
  await expect(login("Do", builtinPassword)).rejects.toMatchObject({ status: 401 });
  await expect(authenticate(request(initial.token))).rejects.toMatchObject({ status: 401 });
});
it("preserves an existing Do account and never restores the initial password", async () => {
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  state.users.push({ ...state.users[0], username: "Do", revision: "existing" });
  await accessStore().write("access.json", state);
  await expect(login("Do", builtinPassword)).rejects.toMatchObject({ status: 401 });
  const result = await login("Do", "test-password-123");
  expect(await authenticate(request(result.token))).toEqual({ username: "Do" });
  const saved = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  expect(saved.users.find(u => u.username === "Do")!.revision).toBe("existing");
});
it("initializes an empty installation without a separate member command", async () => {
  await accessStore().write("access.json", emptyAccess());
  const result = await login("Do", builtinPassword);
  expect(await authenticate(request(result.token))).toEqual({ username: "Do" });
});

/** 真实管理 CLI 与 HTTP 共用账号格式，首次登录前也能停用内置成员。 */
it("supports listing and disabling Do through the real member CLI before its first login", async () => {
  const envFile = path.join(root, "isolated.env"); await writeFile(envFile, "");
  const env = { ...process.env, LIVEPILOT_ENV_FILE: envFile, LIVEPILOT_ACCESS_DIR: root };
  const args = [path.resolve("scripts/member.mjs")];
  const list = execFileSync(process.execPath, [...args, "list"], { env, encoding: "utf8", windowsHide: true });
  expect(list).toContain("Do（启用）"); expect(list).toContain("alice（启用）");
  execFileSync(process.execPath, [...args, "disable", "Do"], { env, windowsHide: true });
  await expect(login("Do", builtinPassword)).rejects.toMatchObject({ status: 401 });
  const existing = await login("alice", "test-password-123");
  expect(await authenticate(request(existing.token))).toEqual({ username: "alice" });
});
