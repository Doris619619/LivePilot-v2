/** 独立发布账号的 Cloud 权限、频道占位、清理隔离与 OAuth 路由；所有 Google 和 Agent RPC 都为合成数据。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
const remote = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/cloud/tasks", async original => ({ ...await original<typeof import("@/cloud/tasks")>(), rpc: remote.rpc }));
import { cloudStore } from "@/cloud/store";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent, setAgentOwner } from "@/cloud/agents";
import { accessStore, emptyAccess } from "@/server/access";
import { defaultPolicy, PRIVACY_VERSION, type PublishingAccount } from "@/shared/publishing";
import { publishingTaskAccountId, type TaskPayload } from "@/shared/remote";
import { unseal } from "@/core/storage";
import { agentPublishingAccounts, authorizePublishingAccount, claimPublishingAccount, expirePublishingAccountData, publishingAccountCleanups, publishingAccounts, requirePublishingAccount, syncPublishingAccounts } from "@/cloud/publishing-accounts";
import * as accountChecks from "@/cloud/publishing-accounts";
import { acceptPublishingPrivacy, chargePublishing, completePublishingCleanup, confirmPublishingBatch, connectPublishingAccount, createPublishingAccount, previewPublishingBatch, previewPublishingPlan, publishingCleanups, publishingStore, publishingTick, publishingView, reportPublishing, requestPublishingAccountCleanup, requestPublishingCleanup, savePublishingPolicy, savePublishingProfile } from "@/cloud/publishing";
import { finishRemoteOAuth, oauthCookie, remoteOAuthContext } from "@/cloud/oauth";
import { enqueue, pollTasks, readTask, reportTasks } from "@/cloud/tasks";
import { fixtureJob } from "./publishing-fixtures";

let root: string; const alice = { username: "alice", role: "customer" as const }; const bob = { username: "bob", role: "customer" as const }; const admin = { username: "admin", role: "admin" as const };
const channels = new Map<string, string>(); const destination = { agentId: "pc", instanceId: "main" };
/** 测试使用真实本地事务与配对身份，仅跨设备网络和 Google 调用被模拟。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-account-cloud-")); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid");
  const access = emptyAccess(); access.users.push(...[alice, bob, admin].map(user => ({ ...user, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false }))); await accessStore().write("access.json", access);
  const pair = await createPairing("pc", "Synthetic", "alice"); await pairAgent("pc", pair.code, "b".repeat(64)); const session = await openSession("pc", randomUUID(), [{ id: "main", name: "Synthetic host" }]); await heartbeatAgent("pc", session.session, []);
  await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-v2", "publishing-accounts-v1"]); await cloudStore().write("bindings.json", [{ ...destination, channelId: "channel_one", confirmed: true }]);
  await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true, privacyContact: "synthetic@example.invalid" }); await acceptPublishingPrivacy(alice, PRIVACY_VERSION);
  channels.clear(); remote.rpc.mockReset(); remote.rpc.mockImplementation(async (_target, _actor, payload: TaskPayload) => {
    if (payload.kind === "publishing-account-oauth-begin") return { url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" + encodeURIComponent("https://synthetic.invalid/api/youtube/callback") + "&state=publishing-" + payload.accountId + "." + "d".repeat(64), cookie: "e".repeat(64) };
    if (payload.kind === "publishing-account-oauth-finish") return { ok: true };
    return { assets: [fixtureJob().asset], thumbnails: [], channelId: channels.get(publishingTaskAccountId(payload) || "") || "channel_one", channel: "Synthetic" };
  });
});
/** 只删除经路径检查的本次临时目录，不访问客户数据或 Token。 */
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-account-cloud-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 模拟真实 Agent 的占位先于 Token、确认随后到达，不交换 OAuth code。 */
async function connected(channelId: string): Promise<PublishingAccount> {
  const account = await createPublishingAccount(alice, "pc", "main", channelId); channels.set(account.id, channelId);
  await claimPublishingAccount("pc", account.id, "main", channelId, "Synthetic " + channelId, false, Date.now()); await claimPublishingAccount("pc", account.id, "main", channelId, "Synthetic " + channelId, true, Date.now());
  return (await agentPublishingAccounts("pc")).find(value => value.id === account.id)!;
}
/** 建立不同频道的合成私密任务，走原批次体系，不实际上传。 */
async function jobFor(account?: PublishingAccount) {
  const profile = await savePublishingProfile(alice, { ...fixtureJob().profile, id: randomUUID(), ...(account ? { accountId: account.id, channelId: account.channelId } : {}) });
  const batch = await previewPublishingBatch(alice, profile.id, [fixtureJob().asset.id]); return (await confirmPublishingBatch(alice, batch.id, false, true))[0];
}
it("creates independent public bindings with ownership checks and never exposes tokens", async () => {
  const account = await connected("publish_channel"); expect(account).toMatchObject({ agentId: "pc", instanceId: "main", status: "connected", channelId: "publish_channel" }); expect(JSON.stringify(await publishingView(alice))).not.toMatch(/refreshToken|accessToken|cookie|clientSecret/);
  expect(await publishingAccounts(bob)).toEqual([]); await expect(authorizePublishingAccount(bob, account.id)).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(await cloudStore().read("bindings.json")).toEqual([{ ...destination, channelId: "channel_one", confirmed: true }]);
});
it("allows a publishing channel to equal its live channel but reserves it globally among publishing accounts", async () => {
  const account = await connected("channel_one"); const other = await createPublishingAccount(alice, "pc", "main", "Other"); await expect(claimPublishingAccount("pc", other.id, "main", "channel_one", "Synthetic", false, Date.now())).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
  await expect(claimPublishingAccount("pc", account.id, "main", "other_channel", "Other", false, Date.now())).rejects.toMatchObject({ code: "CHANNEL" });
});
it("atomically admits exactly one competing publishing reservation", async () => {
  const first = await createPublishingAccount(alice, "pc", "main", "First"); const second = await createPublishingAccount(alice, "pc", "main", "Second");
  const results = await Promise.allSettled([first, second].map(account => claimPublishingAccount("pc", account.id, "main", "same_channel", "Synthetic", false, Date.now()))); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
it("rejects device reassignment and source-host substitution", async () => {
  const account = await connected("publish_channel"); await expect(requirePublishingAccount("pc", "other", account.id)).rejects.toMatchObject({ code: "INSTANCE" }); await setAgentOwner("pc", "bob");
  await expect(authorizePublishingAccount(bob, account.id)).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(requirePublishingAccount("pc", "main", account.id)).rejects.toMatchObject({ code: "ACCOUNT" }); expect(await publishingAccounts(bob)).toEqual([]);
});
it("routes OAuth begin/finish to account payloads, locks the original channel and consumes state once", async () => {
  const account = await connected("publish_channel"); const oauth = await connectPublishingAccount(alice, account.id); expect(remote.rpc.mock.calls[0][2]).toEqual({ kind: "publishing-account-oauth-begin", accountId: account.id });
  expect(await remoteOAuthContext(oauth.state, oauth.cookie, "alice")).toEqual({ ...destination, accountId: account.id }); await expect(remoteOAuthContext(oauth.state, "f".repeat(64), "alice")).rejects.toMatchObject({ code: "OAUTH" });
  expect(await finishRemoteOAuth(oauth.state, oauth.cookie, "alice", "synthetic-code", alice)).toEqual({ ...destination, accountId: account.id }); expect(remote.rpc.mock.calls.at(-1)![2]).toMatchObject({ kind: "publishing-account-oauth-finish", accountId: account.id, expectedChannel: "publish_channel" });
  await expect(finishRemoteOAuth(oauth.state, oauth.cookie, "alice", "synthetic-code", alice)).rejects.toMatchObject({ code: "OAUTH" }); expect(oauthCookie(oauth.state)).toMatch(/^livepilot_cloud_oauth_/);
});
it("keeps the pinned channel when the local token disappears and prevents UUID reuse after deletion", async () => {
  const account = await connected("publish_channel"); await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main" }]); const missing = (await agentPublishingAccounts("pc"))[0]; expect(missing).toMatchObject({ status: "unbound", channelId: "publish_channel" });
  const cleanup = await requestPublishingAccountCleanup(alice, account.id); expect(cleanup.state).toBe("pending"); await completePublishingCleanup("pc", cleanup.id); await expect(authorizePublishingAccount(alice, account.id)).rejects.toMatchObject({ code: "ACCOUNT" });
  await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main", channelId: "publish_channel", channel: "Stale" }]); expect((await agentPublishingAccounts("pc"))[0].status).toBe("deleted");
});
it("deletes one account's jobs/profiles/tasks while retaining another account and the legacy live token route", async () => {
  const first = await connected("publish_a"); const second = await connected("publish_b"); const a = await jobFor(first); const b = await jobFor(second); const legacy = await jobFor(); await publishingTick();
  const cleanup = await requestPublishingAccountCleanup(alice, first.id); const view = await publishingView(alice); expect(view.jobs.map(job => job.spec.id).sort()).toEqual([b.spec.id, legacy.spec.id].sort());
  const queue = await agentStore("pc").read<{ records: { payload: string }[] }>("tasks.json"); expect(queue?.records.map(record => publishingTaskAccountId(unseal<TaskPayload>(record.payload)))).toEqual([second.id, undefined]); expect(view.jobs.some(job => job.spec.id === a.spec.id)).toBe(false);
  expect(await publishingCleanups("pc")).toContainEqual(expect.objectContaining({ accountId: first.id, id: cleanup.id })); await expect(completePublishingCleanup("other", cleanup.id)).rejects.toMatchObject({ code: "CLEANUP" }); await completePublishingCleanup("pc", cleanup.id);
  expect((await agentPublishingAccounts("pc")).find(account => account.id === first.id)?.status).toBe("deleted"); expect((await agentPublishingAccounts("pc")).find(account => account.id === second.id)?.status).toBe("connected"); expect(await cloudStore().read("bindings.json")).toEqual([{ ...destination, channelId: "channel_one", confirmed: true }]);
});
it("legacy cleanup preserves independent publishing records and directives sharing the same host", async () => {
  const account = await connected("publish_a"); const independent = await jobFor(account); const legacy = await jobFor(); await publishingTick(); const cleanup = await requestPublishingCleanup(alice, "pc", "main");
  expect((await publishingView(alice)).jobs.map(job => job.spec.id)).toEqual([independent.spec.id]); expect((await publishingView(alice)).jobs.some(job => job.spec.id === legacy.spec.id)).toBe(false); await completePublishingCleanup("pc", cleanup.id);
  expect((await agentStore("pc").read<{ records: { payload: string }[] }>("tasks.json"))?.records.map(record => publishingTaskAccountId(unseal<TaskPayload>(record.payload)))).toEqual([account.id]); expect((await agentPublishingAccounts("pc"))[0].status).toBe("connected");
});
it("turns an invalid grant into account-only cleanup without wiping peers", async () => {
  const first = await connected("publish_a"); const second = await connected("publish_b"); const a = await jobFor(first); const b = await jobFor(second);
  await reportPublishing("pc", [{ id: a.spec.id, revision: 1, sequence: 1, state: "needs_attention", offset: 0, total: a.spec.asset.size, updatedAt: Date.now(), authorizationInvalid: true }]); expect((await publishingView(alice)).jobs.map(job => job.spec.id)).toEqual([b.spec.id]); expect((await publishingAccountCleanups("pc"))[0].accountId).toBe(first.id);
});
it("never dispatches independent jobs to an old Agent or admits API work after token loss", async () => {
  const account = await connected("publish_a"); const job = await jobFor(account); await agentStore("pc").write("capabilities.json", ["publishing-v1", "publishing-v2"]); await publishingTick(); expect(await agentStore("pc").read("tasks.json")).toBeNull();
  await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main" }]); await expect(chargePublishing("pc", job.spec.id, randomUUID(), 1, false)).rejects.toMatchObject({ code: "CHANNEL" });
});
it("refuses a new package Plan made with a legacy Profile instead of guessing an account", async () => {
  const profile = await savePublishingProfile(alice, fixtureJob().profile); await expect(previewPublishingPlan(alice, profile.id, "c".repeat(64), { timezone: "UTC", startDate: "2026-10-02", weeklySlots: [{ weekday: 5, time: "18:00" }], preuploadDays: 28 })).rejects.toMatchObject({ code: "ACCOUNT" });
});
it("expires channel titles without letting cached sync or heartbeat extend API retention", async () => {
  const account = await connected("publish_a"); const checkedAt = account.channelCheckedAt!; vi.setSystemTime(Date.now() + 29 * 86400_000);
  await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main", channelId: "publish_a", channel: "Cached", channelCheckedAt: checkedAt }]); expect((await agentPublishingAccounts("pc"))[0].channelCheckedAt).toBe(checkedAt);
  vi.setSystemTime(Date.now() + 2 * 86400_000); await expirePublishingAccountData(); expect((await agentPublishingAccounts("pc"))[0]).toMatchObject({ channelId: "publish_a", status: "connected" }); expect((await agentPublishingAccounts("pc"))[0].channel).toBeUndefined();
  await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main", channelId: "publish_a", channel: "Old title", channelCheckedAt: checkedAt }]); expect((await agentPublishingAccounts("pc"))[0].channel).toBeUndefined(); expect(JSON.stringify(await cloudStore().read("publishing-accounts.json"))).not.toContain("Old title");
  await syncPublishingAccounts("pc", [{ id: account.id, instanceId: "main", channelId: "publish_a", channel: "Fresh API title", channelCheckedAt: Date.now() }]); expect((await agentPublishingAccounts("pc"))[0].channel).toBe("Fresh API title");
});
/** 模拟外层目标校验通过后、发布写事务开始前完成删除，保存配置仍须拒绝迟到写入。 */
it("rechecks an account inside profile writes after the earlier authorization raced cleanup", async () => {
  const account = await connected("publish_a"); const check = requirePublishingAccount;
  vi.spyOn(accountChecks, "requirePublishingAccount").mockImplementationOnce(async (...args) => {
    const value = await check(...args); const cleanup = await requestPublishingAccountCleanup(alice, account.id); await completePublishingCleanup("pc", cleanup.id); return value;
  });
  await expect(savePublishingProfile(alice, { ...fixtureJob().profile, id: randomUUID(), accountId: account.id, channelId: account.channelId })).rejects.toMatchObject({ code: "CLEANUP" });
  expect((await publishingView(alice)).profiles).toEqual([]);
});
/** 旧扁平预览继续兼容独立账号，但延迟扫描结果同样不能恢复已经删除的批次。 */
it("rejects a legacy asset preview arriving after independent account deletion", async () => {
  const account = await connected("publish_a"); const profile = await savePublishingProfile(alice, { ...fixtureJob().profile, id: randomUUID(), accountId: account.id, channelId: account.channelId });
  let finishScan!: (value: unknown) => void; let scanning!: () => void; const started = new Promise<void>(resolve => { scanning = resolve; });
  remote.rpc.mockImplementationOnce(() => { scanning(); return new Promise(resolve => { finishScan = resolve; }); });
  const pending = previewPublishingBatch(alice, profile.id, [fixtureJob().asset.id]); const rejected = expect(pending).rejects.toMatchObject({ code: "CLEANUP" }); await started;
  const cleanup = await requestPublishingAccountCleanup(alice, account.id); await completePublishingCleanup("pc", cleanup.id);
  finishScan({ assets: [fixtureJob().asset], thumbnails: [], channelId: account.channelId }); await rejected;
  const saved = await publishingStore().read<{ profiles: unknown[]; batches: unknown[] }>("state.json"); expect(saved!.profiles).toEqual([]); expect(saved!.batches).toEqual([]);
});
/** 原实例授权删除完成后没有绑定，旧扫描结果不得把已清理的配置批次重新写入。 */
it("rejects a legacy asset preview arriving after instance authorization deletion", async () => {
  const profile = await savePublishingProfile(alice, fixtureJob().profile);
  let finishScan!: (value: unknown) => void; let scanning!: () => void; const started = new Promise<void>(resolve => { scanning = resolve; });
  remote.rpc.mockImplementationOnce(() => { scanning(); return new Promise(resolve => { finishScan = resolve; }); });
  const pending = previewPublishingBatch(alice, profile.id, [fixtureJob().asset.id]); const rejected = expect(pending).rejects.toMatchObject({ code: "CHANNEL" }); await started;
  const cleanup = await requestPublishingCleanup(alice, "pc", "main"); await completePublishingCleanup("pc", cleanup.id);
  finishScan({ assets: [fixtureJob().asset], thumbnails: [], channelId: profile.channelId }); await rejected;
  expect((await publishingStore().read<{ batches: unknown[] }>("state.json"))!.batches).toEqual([]);
});
it("accepts strict package and archive RPC reports through the real task reporter", async () => {
  const scan = await enqueue(destination, "alice", { kind: "publishing-packages" }); await pollTasks("pc"); await reportTasks("pc", [{ id: scan.id, status: "succeeded", result: { root: "Synthetic/Publishing", batches: [], thumbnails: [] } }]); expect(unseal((await readTask("pc", scan.id))!.result!)).toEqual({ root: "Synthetic/Publishing", batches: [], thumbnails: [] });
  const archive = await enqueue(destination, "alice", { kind: "publishing-archive", archiveId: randomUUID(), batch: { id: "c".repeat(64), name: "Batch", version: "d".repeat(64), packages: [], issues: [] } }); await pollTasks("pc"); await reportTasks("pc", [{ id: archive.id, status: "succeeded", result: { state: "complete", destination: "Synthetic/Publishing/Completed/Batch" } }]); expect(unseal((await readTask("pc", archive.id))!.result!)).toEqual({ state: "complete", destination: "Synthetic/Publishing/Completed/Batch" });
});
