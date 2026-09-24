/** 真实隔离账号存储验证管理员授权、原子写入、密码撤销与部署降权。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { accessStore, emptyAccess, passwordHash, login, authenticate } from "@/server/access";
import { GET, POST } from "@/app/api/admin/accounts/route";
let root: string; let admin: string; let customer: string;
/** 只写测试临时目录，合成管理员必须同时具备角色和 U 前缀。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-account-admin-")); vi.stubEnv("LIVEPILOT_ACCESS_DIR", root); vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010");
  const state = emptyAccess(); const salt = "a".repeat(32); const hash = (await passwordHash("synthetic-password", salt)).toString("hex");
  for (const [username, role] of [["UAdmin", "admin"], ["Do", "admin"], ["UCustomer", "customer"], ["Customer", "customer"]] as const) state.users.push({ username, role, salt, hash, revision: "old", disabled: false });
  await accessStore().write("access.json", state); admin = (await login("UAdmin", "synthetic-password")).token; customer = (await login("Do", "synthetic-password")).token;
});
/** 清理边界只接受本测试生成的目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-account-admin-")) throw Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 构造真实管理员同源会话，不 mock 鉴权。 */
function request(body?: unknown, token = admin, origin = "http://127.0.0.1:3010") { return new Request("http://127.0.0.1:3010/api/admin/accounts", { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:3010", origin, cookie: "livepilot_session=" + token, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
it("creates only customers, rejects role injection and exposes no secrets", async () => {
  expect((await POST(request({ action: "create", username: "Alice", password: "new-password" }))).status).toBe(200);
  expect((await login("Alice", "new-password", true)).user.role).toBe("customer");
  expect((await POST(request({ action: "create", username: "UAlice", password: "new-password" }))).status).toBe(400);
  expect((await POST(request({ action: "create", username: "Alice2", password: "new-password", role: "admin" }))).status).toBe(400);
  expect((await POST(request({ action: "create", username: "Alice", password: "new-password" }))).status).toBe(409);
  const list = await (await GET(request())).text(); expect(list).not.toMatch(/salt|hash|revision|password|UAdmin/);
  expect(list).toContain("UCustomer");
});
it("rejects customers, name-only admins and cross-origin mutations", async () => {
  expect((await GET(request(undefined, customer))).status).toBe(403);
  const token = (await login("UCustomer", "synthetic-password")).token;
  const value = { action: "reset", username: "Customer", password: "new-password" };
  expect((await POST(request(value, token))).status).toBe(403);
  expect((await POST(request(value, admin, "https://other.example"))).status).toBe(403);
});
it("resets passwords, revokes old sessions, records audit and preserves disabled status", async () => {
  const token = (await login("Customer", "synthetic-password")).token;
  expect((await POST(request({ action: "reset", username: "Customer", password: "new-password" }))).status).toBe(200);
  await expect(authenticate(request(undefined, token))).rejects.toMatchObject({ status: 401 });
  await expect(login("Customer", "synthetic-password")).rejects.toMatchObject({ status: 401 });
  expect((await login("Customer", "new-password")).user.role).toBe("customer");
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  expect(state.accountEvents?.at(-1)).toMatchObject({ actor: "UAdmin", action: "reset", username: "Customer" });
  state.users.find(u => u.username === "Customer")!.disabled = true; await accessStore().write("access.json", state);
  expect((await POST(request({ action: "reset", username: "Customer", password: "another-password" }))).status).toBe(200);
  await expect(login("Customer", "another-password")).rejects.toMatchObject({ status: 401 });
});
it("migration is idempotent, revokes only demoted sessions and preserves password hashes", async () => {
  const before = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  const envFile = path.join(root, "empty.env"); await writeFile(envFile, "");
  const run = () => execFileSync(process.execPath, ["scripts/migrate-account-roles.mjs"], { env: { ...process.env, LIVEPILOT_ENV_FILE: envFile }, encoding: "utf8", windowsHide: true });
  expect(run()).toContain('"Do"'); expect(run()).toContain('"changed":[]');
  const after = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  expect(after.users.map(u => u.hash)).toEqual(before.users.map(u => u.hash));
  await expect(authenticate(request(undefined, customer))).rejects.toMatchObject({ status: 401 });
  expect((await authenticate(request())).role).toBe("admin");
  expect((await login("Do", "synthetic-password", true)).user.role).toBe("customer");
});
