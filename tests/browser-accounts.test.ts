/** 隔离账号回归：首次密码验证、浏览器切换、过期撤销和旧标签页身份保护，不使用真实成员凭据。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import type { NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { accessStore, authenticate, digest, emptyAccess, login, passwordHash, SESSION_COOKIE } from "@/server/access";
import { accountTokens, BROWSER_ACCOUNTS_COOKIE } from "@/server/browser-accounts";
import { POST as signIn, DELETE as signOut } from "@/app/api/session/route";
import { GET as list, POST as switchAccount } from "@/app/api/session/accounts/route";
let root: string;
const origin = "http://127.0.0.1:3010";
/** 独立测试数据包含客户与明确管理员；共享合成密码摘要加快测试，不加载生产状态。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "livenest-browser-accounts-")); vi.stubEnv("LIVEPILOT_ACCESS_DIR", root); vi.stubEnv("LIVEPILOT_ORIGIN", origin);
  const state = emptyAccess(); const hash = (await passwordHash("synthetic-pass-123", "a".repeat(32))).toString("hex");
  for (const username of ["alice", "ULiang", "bravo", "charlie", "delta", "echo", "foxtrot"]) state.users.push({ username, role: username === "ULiang" ? "admin" : "customer", salt: "a".repeat(32), hash, revision: "one", disabled: false });
  await accessStore().write("access.json", state);
});
/** 只清理本测试创建的目录，绝不删除用户账号状态。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("livenest-browser-accounts-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 构造同源合成浏览器请求；凭据只在测试内存里。 */
function request(cookie = "", body?: unknown, method = body ? "POST" : "GET", expected?: string) {
  return new Request(origin + "/api/session", { method, headers: { host: "127.0.0.1:3010", origin, "x-livepilot": "1", "content-type": "application/json", cookie, ...(expected ? { "x-livepilot-user": expected } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it("remembers a legacy active login and switches only between password-verified sessions", async () => {
  const first = await login("alice", "synthetic-pass-123");
  const response = await signIn(request(SESSION_COOKIE + "=" + first.token, { username: "ULiang", password: "synthetic-pass-123" })) as NextResponse;
  expect(response.status).toBe(200); expect(await response.clone().json()).toEqual({ user: { username: "ULiang", role: "admin" } });
  expect(response.cookies.get(BROWSER_ACCOUNTS_COOKIE)?.httpOnly).toBe(true);
  const current = response.cookies.get(SESSION_COOKIE)!.value;
  const cookie = `${SESSION_COOKIE}=${current}; ${BROWSER_ACCOUNTS_COOKIE}=${response.cookies.get(BROWSER_ACCOUNTS_COOKIE)!.value}`;
  const listing = await (await list(request(cookie))).json(); expect(listing.accounts).toEqual(expect.arrayContaining([{ username: "alice", role: "customer", current: false }, { username: "ULiang", role: "admin", current: true }]));
  expect(JSON.stringify(listing)).not.toContain(first.token); expect(JSON.stringify(listing)).not.toContain(current);
  const switched = await switchAccount(request(cookie, { username: "alice" })); expect(switched.status).toBe(200); expect(switched.headers.get("set-cookie")).toContain(first.token);
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!; expect(state.sessions[digest(first.token)].expires).toBe(first.expires);
  expect((await switchAccount(request(cookie, { username: "bravo" }))).status).toBe(409);
});
it.each(["expired", "reset", "disabled", "desktop"])("does not switch an invalid saved %s session", async kind => {
  const saved = await login("alice", "synthetic-pass-123", kind === "desktop"); const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!;
  if (kind === "expired") state.sessions[digest(saved.token)].expires = 1;
  if (kind === "reset") state.users[0].revision = "two";
  if (kind === "disabled") state.users[0].disabled = true;
  await accessStore().write("access.json", state); const cookie = `${BROWSER_ACCOUNTS_COOKIE}=${accountTokens([saved.token])}`;
  expect(await (await list(request(cookie))).json()).toEqual({ accounts: [] }); expect((await switchAccount(request(cookie, { username: "alice" }))).status).toBe(409);
});
it("logout revokes only the current account and keeps a different saved login usable", async () => {
  const a = await login("alice", "synthetic-pass-123"); const b = await login("ULiang", "synthetic-pass-123");
  const cookie = `${SESSION_COOKIE}=${a.token}; ${BROWSER_ACCOUNTS_COOKIE}=${accountTokens([a.token, b.token])}`;
  const response = await signOut(request(cookie, undefined, "DELETE", "alice")); expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toContain(BROWSER_ACCOUNTS_COOKIE);
  expect((await switchAccount(request(cookie, { username: "ULiang" }))).status).toBe(200); expect((await switchAccount(request(cookie, { username: "alice" }))).status).toBe(409);
});
it("rejects a stale tab's request rather than executing it as the new active member", async () => {
  const b = await login("ULiang", "synthetic-pass-123");
  await expect(authenticate(request(`${SESSION_COOKIE}=${b.token}`, undefined, "GET", "alice"))).rejects.toMatchObject({ code: "ACCOUNT_CHANGED", status: 409 });
  expect(await authenticate(request(`${SESSION_COOKIE}=${b.token}`, undefined, "GET", "ULiang"))).toEqual({ username: "ULiang", role: "admin" });
  expect((await signOut(request(`${SESSION_COOKIE}=${b.token}`, undefined, "DELETE", "alice"))).status).toBe(409);
});
it("rejects cross-origin switching and caps remembered logins at six", async () => {
  const tokens: string[] = [];
  for (const username of ["alice", "ULiang", "bravo", "charlie", "delta", "echo"]) { const result = await login(username, "synthetic-pass-123"); tokens.push(result.token); }
  const cookie = `${BROWSER_ACCOUNTS_COOKIE}=${accountTokens(tokens)}`; expect((await signIn(request(cookie, { username: "foxtrot", password: "synthetic-pass-123" }))).status).toBe(409);
  const cross = new Request(origin + "/api/session/accounts", { method: "POST", headers: { host: "127.0.0.1:3010", origin: "https://other.invalid", "x-livepilot": "1", "content-type": "application/json", cookie }, body: JSON.stringify({ username: "alice" }) }); expect((await switchAccount(cross)).status).toBe(403);
});
it("filters six stale credentials before finding a later valid remembered account", async () => {
  const valid = await login("alice", "synthetic-pass-123"); const stale = Array.from({ length: 6 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
  const cookie = `${BROWSER_ACCOUNTS_COOKIE}=${accountTokens([...stale, valid.token])}`;
  expect(await (await list(request(cookie))).json()).toEqual({ accounts: [{ username: "alice", role: "customer", current: false }] });
  expect((await switchAccount(request(cookie, { username: "alice" }))).status).toBe(200);
});
