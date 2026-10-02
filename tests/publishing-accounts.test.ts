/** 独立发布账号的加密 OAuth、重连与清理隔离；全部 Google 及 Cloud 回复均为合成数据。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishingAccounts } from "@/core/publishing/accounts";
import { Store, seal } from "@/core/storage";
import { PublishingRunner } from "@/core/publishing/runner";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";
import type { Service } from "@/core/service";

let root: string;
/** 请求只返回按合成 code 区分的 Token 和频道，从不访问 Google。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-accounts-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://cloud.example.invalid"); vi.stubEnv("GOOGLE_CLIENT_ID", "test-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubGlobal("fetch", vi.fn(async (url: string, input: RequestInit) => {
    if (url.includes("/token")) { const body = new URLSearchParams(input.body as URLSearchParams); const code = body.get("code") || body.get("refresh_token")?.replace("REFRESH_", "") || "one"; return Response.json({ access_token: "ACCESS_" + code, refresh_token: "REFRESH_" + code, expires_in: 3600 }); }
    if (url.includes("/revoke")) return Response.json({});
    const token = new Headers(input.headers).get("authorization") || ""; return Response.json({ items: [{ id: token.includes("two") ? "channel_two" : "channel_one", snippet: { title: token.includes("two") ? "Channel Two" : "Channel One" } }] });
  }));
});
/** 只删除本测试创建的临时目录，恢复网络函数和环境。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-accounts-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 在隔离账号发起和完成一次合成授权，state 由真实 PKCE 实现生成。 */
async function connect(accounts: PublishingAccounts, id: string, code = "one", expected?: string) { const begin = await accounts.begin(id, "main", "alice"); await accounts.finish(id, "main", begin.cookie, new URL(begin.url).searchParams.get("state")!, code, "alice", expected); }

it("claims then saves an isolated encrypted publishing token without changing the live authorization or binding", async () => {
  const live = new Store(root); await live.write("youtube.enc", seal({ accessToken: "LIVE_ACCESS", refreshToken: "LIVE_REFRESH", channelId: "live_channel" })); await live.write("control.json", { phase: "live", channelId: "live_channel", broadcastId: "live_broadcast" });
  const originalToken = await readFile(path.join(root, "youtube.enc"), "utf8"); const originalControl = await readFile(path.join(root, "control.json"), "utf8"); const id = randomUUID(); const calls: boolean[] = [];
  const accounts = new PublishingAccounts(async (accountId, instanceId, channel, confirm) => { expect(accountId).toBe(id); expect(instanceId).toBe("main"); expect(channel.channelId).toBe("channel_one"); expect(!!await accounts.auth(id).tokens()).toBe(confirm); calls.push(confirm); });
  await connect(accounts, id); expect(calls).toEqual([false, true]);
  const encrypted = await readFile(path.join(accounts.store(id).dir, "youtube.enc"), "utf8"); expect(encrypted).not.toContain("ACCESS_one"); expect(encrypted).not.toContain("REFRESH_one");
  expect(await readFile(path.join(root, "youtube.enc"), "utf8")).toBe(originalToken); expect(await readFile(path.join(root, "control.json"), "utf8")).toBe(originalControl);
  expect(await accounts.statuses()).toEqual([{ id, instanceId: "main", channelId: "channel_one", channel: "Channel One", connectedAt: expect.any(Number), channelCheckedAt: expect.any(Number) }]);
});

it("isolates two accounts on one host and rejects a reconnect to a different channel before saving", async () => {
  const accounts = new PublishingAccounts(async () => {}); const a = randomUUID(); const b = randomUUID(); await connect(accounts, a); await connect(accounts, b, "two");
  const before = await readFile(path.join(accounts.store(a).dir, "youtube.enc"), "utf8"); await expect(connect(accounts, a, "two")).rejects.toMatchObject({ code: "CHANNEL" });
  expect(await readFile(path.join(accounts.store(a).dir, "youtube.enc"), "utf8")).toBe(before); expect((await accounts.auth(a).tokens())?.channelId).toBe("channel_one"); expect((await accounts.auth(b).tokens())?.channelId).toBe("channel_two");
});

it("does not persist a token if Cloud rejects the account channel reservation", async () => {
  const accounts = new PublishingAccounts(async () => { throw new Error("synthetic reservation rejection"); }); const id = randomUUID(); await expect(connect(accounts, id)).rejects.toThrow("synthetic reservation rejection"); expect(await accounts.auth(id).tokens()).toBeNull();
});

it("recovers a lost Cloud confirmation using the exact local account after a process restart", async () => {
  const id = randomUUID(); const binding = vi.fn(async (_id: string, _instance: string, _channel: unknown, confirm: boolean) => { if (confirm) throw new Error("lost confirmation"); }); const first = new PublishingAccounts(binding);
  await expect(connect(first, id)).rejects.toThrow("lost confirmation"); expect((await first.auth(id).tokens())?.channelId).toBe("channel_one");
  const restoredBinding = vi.fn(async () => {}); const restored = new PublishingAccounts(restoredBinding); await restored.register(); expect(restoredBinding).toHaveBeenCalledExactlyOnceWith(id, "main", { channelId: "channel_one", channel: "Channel One", channelCheckedAt: expect.any(Number) }, true);
});

it("binds PKCE transactions to their publishing account and actor", async () => {
  const accounts = new PublishingAccounts(async () => {}); const a = randomUUID(); const b = randomUUID(); const begin = await accounts.begin(a, "main", "alice"); await accounts.begin(b, "main", "alice");
  await expect(accounts.finish(b, "main", begin.cookie, new URL(begin.url).searchParams.get("state")!, "one", "alice")).rejects.toMatchObject({ code: "OAUTH_STATE" });
  await accounts.finish(a, "main", begin.cookie, new URL(begin.url).searchParams.get("state")!, "one", "alice"); expect(await accounts.auth(b).tokens()).toBeNull();
  const retry = await accounts.begin(b, "main", "alice"); await expect(accounts.finish(b, "main", retry.cookie, new URL(retry.url).searchParams.get("state")!, "two", "bob")).rejects.toMatchObject({ code: "OAUTH_STATE" });
});

it("persists account cleanup through a failed revoke and preserves other publishing accounts and live files", async () => {
  const accounts = new PublishingAccounts(async () => {}); const a = randomUUID(); const b = randomUUID(); await connect(accounts, a); await connect(accounts, b, "two"); const live = new Store(root); await live.write("youtube.enc", seal({ channelId: "live_channel" })); const original = await readFile(path.join(root, "youtube.enc"), "utf8"); const date = Date.now(); await accounts.startCleanup(a, "main", date);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 503 })); await expect(accounts.revoke(a)).rejects.toMatchObject({ code: "GOOGLE_UNAVAILABLE" }); expect(await accounts.auth(a).tokens()).toBeNull();
  const restored = new PublishingAccounts(async () => {}); await expect(restored.begin(a, "main", "alice")).rejects.toMatchObject({ code: "CLEANUP" }); expect((await restored.statuses()).find(value => value.id === a)).toMatchObject({ cleanupPending: true });
  await restored.revoke(a); await restored.completeCleanup(a); await expect(restored.assertAvailable(a, "main", date - 1)).rejects.toMatchObject({ code: "ACCOUNT_DELETED" }); await expect(restored.begin(a, "main", "alice")).rejects.toMatchObject({ code: "ACCOUNT_DELETED" }); expect((await restored.auth(b).tokens())?.channelId).toBe("channel_two"); expect(await readFile(path.join(root, "youtube.enc"), "utf8")).toBe(original);
});

it("uses the publishing account to check upload identity without falling back to host live credentials", async () => {
  const accounts = new PublishingAccounts(async () => {}); const id = randomUUID(); await connect(accounts, id); const { api } = fixtureApi(); const spec = fixtureJob(); spec.profile.accountId = id;
  const liveTokens = vi.fn(async () => ({ channelId: "live_channel" })); const service = { auth: { tokens: liveTokens } } as unknown as Service;
  const runner = new PublishingRunner(new Map([["main", service]]), { api: () => api, accountAuth: accountId => accounts.auth(accountId) }); await runner.apply(spec); await runner.tick(); await runner.stop(); expect(liveTokens).not.toHaveBeenCalled(); expect(await runner.expectedChannel("main")).toBeUndefined(); expect(await runner.expectedChannel("main", id)).toBe("channel_one");
  await expect(runner.apply({ ...spec, revision: 2, profile: { ...spec.profile, accountId: randomUUID() } })).rejects.toMatchObject({ code: "REQUEST" });
});

it("allows independent account OAuth while the host legacy authorization is being cleaned", async () => {
  const transport = new Transport("https://cloud.example.invalid", "pc", "b".repeat(64)); vi.spyOn(transport, "post").mockResolvedValue({ ok: true }); const executor = new Executor(transport); await new Store(root).write("publishing-purge.json", { pending: true, createdAt: Date.now() });
  const result = await executor.execute({ protocol: 1, id: randomUUID(), agentId: "pc", instanceId: "main", actor: "alice", expiresAt: Date.now() + 60_000, payload: { kind: "publishing-account-oauth-begin", accountId: randomUUID() } }); expect(result).toMatchObject({ url: expect.stringContaining("state=publishing-") });
});

it("recovers a lost cleanup acknowledgement from Cloud's permanent deleted account response", async () => {
  const id = randomUUID(); const request = randomUUID(); const date = Date.now(); let syncs = 0; const transport = new Transport("https://cloud.example.invalid", "pc", "b".repeat(64));
  vi.spyOn(transport, "post").mockImplementation(async route => { if (route.endsWith("accounts-binding")) return { ok: true } as never; if (route.endsWith("/cleanup")) throw new Error("synthetic lost response"); if (route.endsWith("/sync")) return { acknowledged: [], cleanups: ++syncs === 1 ? [{ id: request, accountId: id, instanceId: "main", createdAt: date }] : [], accounts: syncs > 1 ? [{ id, agentId: "pc", instanceId: "main", status: "deleted", updatedAt: date, deletedAt: date }] : [] } as never; throw new Error("Unexpected route"); });
  const executor = new Executor(transport); await connect(executor.publishingAccounts, id); executor.connectPublishing(true, true);
  await vi.waitFor(async () => expect(await executor.publishingAccounts.store(id).read("account.json")).toMatchObject({ deleted: true, purge: { pending: false } }), { timeout: 4000 });
  expect(await executor.publishingAccounts.auth(id).tokens()).toBeNull(); await expect(executor.publishingAccounts.begin(id, "main", "alice")).rejects.toMatchObject({ code: "ACCOUNT_DELETED" }); await executor.stopPublishing();
});

it("continues other publishing work while one account's revoke remains pending", async () => {
  const id = randomUUID(); const other = randomUUID(); const transport = new Transport("https://cloud.example.invalid", "pc", "b".repeat(64));
  vi.spyOn(transport, "post").mockImplementation(async route => route.endsWith("/sync") ? { acknowledged: [], cleanups: [{ id: randomUUID(), accountId: id, instanceId: "main", createdAt: Date.now() }], accounts: [] } as never : { ok: true } as never);
  const executor = new Executor(transport); await connect(executor.publishingAccounts, id); await connect(executor.publishingAccounts, other, "two"); const tick = vi.spyOn(executor.publishing, "tick").mockResolvedValue(undefined);
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 503 })); executor.connectPublishing(true, true);
  await vi.waitFor(() => expect(tick).toHaveBeenCalled()); expect((await executor.publishingAccounts.auth(other).tokens())?.channelId).toBe("channel_two"); await expect(executor.publishingAccounts.begin(id, "main", "alice")).rejects.toMatchObject({ code: "CLEANUP" }); await executor.stopPublishing();
});

it("refreshes cached channel metadata using a real mocked API read instead of treating repeated reports or token refresh as freshness", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-01-01T00:00:00Z"); vi.setSystemTime(start); const id = randomUUID(); const accounts = new PublishingAccounts(async () => {}); await connect(accounts, id); vi.mocked(fetch).mockClear();
  vi.setSystemTime(start + 24 * 86400_000); expect((await accounts.statuses())[0].channelCheckedAt).toBe(start); expect(fetch).not.toHaveBeenCalled();
  vi.setSystemTime(start + 25 * 86400_000); const status = (await accounts.statuses())[0]; expect(status.channelCheckedAt).toBe(Date.now()); expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(["https://oauth2.googleapis.com/token", expect.stringContaining("/youtube/v3/channels?")]);
  vi.mocked(fetch).mockClear(); vi.setSystemTime(Date.now() + 1000); expect((await accounts.statuses())[0].channelCheckedAt).toBe(status.channelCheckedAt); expect(fetch).not.toHaveBeenCalled();
});

it("deletes expired cached channel titles after a failed refresh, retains the target identity and persists retry backoff across restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.parse("2026-01-01T00:00:00Z"); vi.setSystemTime(start); const id = randomUUID(); const accounts = new PublishingAccounts(async () => {}); await connect(accounts, id); vi.mocked(fetch).mockReset().mockRejectedValue(new Error("synthetic network failure"));
  vi.setSystemTime(start + 31 * 86400_000); const status = (await accounts.statuses())[0]; expect(status).toMatchObject({ channelId: "channel_one", channelCheckedAt: start }); expect(status.channel).toBeUndefined(); expect((await accounts.auth(id).tokens())?.channel).toBe("");
  expect(await accounts.store(id).read("account.json")).toMatchObject({ channelId: "channel_one", channelCheckedAt: start }); expect((await accounts.store(id).read<{ channel?: string }>("account.json"))?.channel).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
  const restored = new PublishingAccounts(async () => {}); vi.setSystemTime(Date.now() + 1000); expect((await restored.statuses())[0].channel).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
});
