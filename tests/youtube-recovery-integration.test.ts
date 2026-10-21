/** 配额保护与授权恢复组合回归：Cloud/RPC/Executor/Runner均使用真实实现，Google只返回合成响应。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { AgentYouTubeUsage } from "@/agent/youtube-usage";
import { agentStore, createPairing, heartbeatAgent, openSession, pairAgent } from "@/cloud/agents";
import { beginRemoteOAuth, finishRemoteOAuth } from "@/cloud/oauth";
import { agentPublishingAccounts, claimPublishingAccount, createPublishingAccount, syncPublishingAccounts } from "@/cloud/publishing-accounts";
import { acceptPublishingPrivacy, changePublishingJob, completePublishingCleanup, connectPublishingAccount, publishingCleanups, publishingStore, reportPublishing, savePublishingPolicy } from "@/cloud/publishing";
import { pollTasks, reportTasks, terminal, type TaskRecord } from "@/cloud/tasks";
import { admitYouTube, reportYouTubeResult, updateYouTubePolicy } from "@/cloud/youtube-usage";
import { ingestYouTubeUsage } from "@/cloud/youtube-usage-events";
import { readYouTubeUsage, youtubeDay } from "@/cloud/youtube-usage-store";
import { quotaDay } from "@/core/publishing/schedule";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
import { seal } from "@/core/storage";
import { VideoApi } from "@/core/youtube/video-api";
import { installYouTubeRuntime } from "@/core/youtube/usage";
import { sleep } from "@/core/errors";
import { accessStore, emptyAccess } from "@/server/access";
import { defaultPolicy, PRIVACY_VERSION, type JobSpec, type PublishingAccountReport, type PublishingReport, type VideoJob } from "@/shared/publishing";
import type { RemoteTask, TaskPayload } from "@/shared/remote";
import type { YouTubeAdmit, YouTubeResult, YouTubeUsageEvent } from "@/shared/youtube-usage";
import { fixtureJob } from "./publishing-fixtures";

const alice = { username: "alice", role: "customer" as const };
const admin = { username: "admin", role: "admin" as const };
const agentId = "recovery_pc", channelId = "synthetic_channel", clientId = "synthetic-recovery-client";
let root: string, executor: Executor, runtime: AgentYouTubeUsage;
let recoveryRunner: PublishingRunner | undefined;
let google: ReturnType<typeof vi.fn>;
let reads: "ok" | "first-401" | "always-401", refreshInvalid: boolean, rejectWrite: boolean, videoReads: number, serial: number;
const attempts: YouTubeAdmit[] = [];
const pendingOperations = new Set<Promise<unknown>>(), pendingDeliveries = new Set<Promise<unknown>>();
let cancellation: AbortController;

/** 网络替身只路由到真实Cloud函数；测试内不安装always-allow准入或模拟RPC。 */
beforeEach(async ({ signal }) => {
  const controller = new AbortController(); cancellation = controller; signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  root = await mkdtemp(path.join(os.tmpdir(), "livepilot-youtube-recovery-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid");
  vi.stubEnv("GOOGLE_CLIENT_ID", clientId); vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  const access = emptyAccess();
  access.users.push(...[alice, admin].map(user => ({ ...user, salt: "synthetic", hash: "synthetic", revision: randomUUID(), disabled: false })));
  await accessStore().write("access.json", access);
  const pair = await createPairing(agentId, "Synthetic recovery", alice.username); await pairAgent(agentId, pair.code, "b".repeat(64));
  const session = await openSession(agentId, randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent(agentId, session.session, []);
  await agentStore(agentId).write("capabilities.json", ["publishing-v1", "publishing-v2", "publishing-accounts-v1", "publishing-recovery-v1", "youtube-quota-v1", "youtube-usage-v1"]);
  await acceptPublishingPrivacy(alice, PRIVACY_VERSION); await savePublishingPolicy(admin, { ...defaultPolicy, enabled: true });
  await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 0, uploads: 0, source: "conservative-estimate" } }, admin.username);
  const transport = new Transport("https://synthetic.invalid", agentId, "b".repeat(64)); transport.session = session.session;
  attempts.length = 0; recoveryRunner = undefined; reads = "ok"; refreshInvalid = false; rejectWrite = false; videoReads = 0; serial = 0;
  vi.spyOn(transport, "post").mockImplementation(async (route, raw) => {
    if (route.endsWith("youtube-quota/admit")) { const input = raw as YouTubeAdmit; attempts.push(input); return await admitYouTube(agentId, input) as never; }
    if (route.endsWith("youtube-quota/result")) return await reportYouTubeResult(agentId, raw as YouTubeResult) as never;
    if (route.endsWith("youtube-usage")) return await ingestYouTubeUsage(agentId, (raw as { events: YouTubeUsageEvent[] }).events) as never;
    if (route.endsWith("publishing/accounts-binding")) {
      const input = raw as { accountId: string; instanceId: string; channelId: string; channel: string; channelCheckedAt: number; confirm: boolean };
      return await claimPublishingAccount(agentId, input.accountId, input.instanceId, input.channelId, input.channel, input.confirm, input.channelCheckedAt) as never;
    }
    if (route.endsWith("publishing/sync")) {
      const input = raw as { reports: PublishingReport[]; accounts?: PublishingAccountReport[] };
      return { acknowledged: await reportPublishing(agentId, input.reports), accounts: input.accounts ? await syncPublishingAccounts(agentId, input.accounts) : await agentPublishingAccounts(agentId), cleanups: await publishingCleanups(agentId) } as never;
    }
    if (route.endsWith("publishing/cleanup")) return await completePublishingCleanup(agentId, (raw as { id: string }).id) as never;
    throw new Error("Unexpected synthetic Cloud route");
  });
  runtime = new AgentYouTubeUsage(transport); runtime.connect(["youtube-quota-v1", "youtube-usage-v1"]); installYouTubeRuntime(runtime);
  executor = new Executor(transport);
  google = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      if ((init?.body as URLSearchParams).get("grant_type") === "refresh_token" && refreshInvalid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "synthetic-access-" + ++serial, refresh_token: "synthetic-refresh-" + serial, expires_in: 3600 });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return Response.json({});
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels?")) return Response.json({ items: [{ id: channelId, snippet: { title: "Synthetic channel" } }] });
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos?")) {
      videoReads++;
      if (reads === "always-401" || reads === "first-401" && videoReads === 1) return Response.json({}, { status: 401 });
      return Response.json({ items: [{ id: "video_original", snippet: { channelId }, status: { privacyStatus: "private", uploadStatus: "uploaded" }, processingDetails: { processingStatus: "processing" } }] });
    }
    if (rejectWrite && url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?")) return Response.json({}, { status: 401 });
    throw new Error("Unexpected synthetic Google request");
  });
  vi.stubGlobal("fetch", google);
});

/** 停止真实后台对象后，只清理本轮独立临时目录。 */
afterEach(async () => {
  cancellation.abort(new Error("Synthetic recovery fixture stopped"));
  const stopped = await Promise.allSettled([recoveryRunner?.stop(), executor?.stopPublishing()]);
  // 原RPC可能仍在等任务结果；用真实失败回报唤醒，排空后才能恢复环境或删除本例目录。
  const deadline = Date.now() + 50_000;
  while ((pendingOperations.size || pendingDeliveries.size) && Date.now() < deadline) {
    const records = (await agentStore(agentId).read<{ records: TaskRecord[] }>("tasks.json"))?.records || [];
    if (records.some(record => !terminal(record.status))) {
      const tasks = await pollTasks(agentId);
      if (tasks.length) await reportTasks(agentId, tasks.map(task => ({ id: task.id, status: "failed" as const, error: "Synthetic recovery fixture cancelled", httpStatus: 409 })));
    }
    await Promise.race([Promise.allSettled([...pendingOperations, ...pendingDeliveries]), sleep(500)]);
  }
  if (pendingOperations.size || pendingDeliveries.size) throw new Error("Synthetic recovery RPC did not drain; temporary data and environment retained");
  const runtimeStopped = await Promise.allSettled([runtime?.stop()]);
  installYouTubeRuntime(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("livepilot-youtube-recovery-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
  const failure = [...stopped, ...runtimeStopped].find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
}, 60_000);

/** 驱动真实RPC下发的一个短任务；可在本机落盘与Cloud确认之间插入确定的竞态。 */
function deliver<T>(operation: Promise<T>, kind: TaskPayload["kind"], beforeReport?: () => Promise<void>): Promise<T> {
  const delivery = deliverOnce(operation, kind, beforeReport); pendingDeliveries.add(delivery);
  void delivery.then(() => pendingDeliveries.delete(delivery), () => pendingDeliveries.delete(delivery));
  return delivery;
}
/** 入队握手只读安全任务摘要，不用10ms写轮询争夺enqueue的tasks.lock；原RPC拒绝立即透出。 */
async function deliverOnce<T>(operation: Promise<T>, kind: TaskPayload["kind"], beforeReport?: () => Promise<void>) {
  type Outcome = { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };
  let outcome: Outcome | undefined;
  const settled = operation.then(value => { outcome = { status: "fulfilled", value }; return outcome; }, error => { outcome = { status: "rejected", error }; return outcome; });
  pendingOperations.add(settled); void settled.then(() => pendingOperations.delete(settled));
  const assertUnsettled = () => {
    if (outcome?.status === "rejected") throw outcome.error;
    if (outcome?.status === "fulfilled") throw new Error("Synthetic RPC settled before its task was delivered: " + kind);
  };
  let task: RemoteTask | undefined;
  try {
    let queued: Pick<TaskRecord, "id" | "kind" | "status"> | undefined;
    const deadline = Date.now() + 3000;
    do {
      cancellation.signal.throwIfAborted();
      assertUnsettled();
      const records = (await agentStore(agentId).read<{ records: Pick<TaskRecord, "id" | "kind" | "status">[] }>("tasks.json"))?.records || [];
      assertUnsettled();
      queued = records.find(record => record.kind === kind && record.status === "queued");
      if (queued) break;
      await Promise.race([settled, sleep(50)]);
    } while (Date.now() < deadline);
    if (!queued) { assertUnsettled(); throw new Error("Synthetic RPC task was not queued within its fixture deadline: " + kind); }
    // 只有真实任务已落盘才执行一次下发事务，仍使用真实解密、任务状态和Executor流程。
    task = (await pollTasks(agentId)).find(value => value.id === queued.id);
    expect(task, "Persisted RPC task must be delivered: " + kind).toBeDefined();
    await reportTasks(agentId, [{ id: task!.id, status: "running" }]);
    const result = await executor.execute(task!); cancellation.signal.throwIfAborted(); await beforeReport?.(); cancellation.signal.throwIfAborted();
    await reportTasks(agentId, [{ id: task!.id, status: "succeeded", result }]);
  } catch (error) {
    if (task) await reportTasks(agentId, [{ id: task.id, status: "failed", error: "Synthetic task failed", httpStatus: 409 }]);
    throw error;
  }
  const result = await settled; if (result.status === "rejected") throw result.error;
  return result.value;
}

/** 首次和恢复授权都经过真实浏览器事务、RPC任务、Executor及Cloud准入。 */
async function begin(accountId: string) { return deliver(connectPublishingAccount(alice, accountId), "publishing-account-oauth-begin"); }
/** 完成原浏览器事务，绝不替换Cloud的epoch确认逻辑。 */
async function finish(transaction: Awaited<ReturnType<typeof beginRemoteOAuth>>, beforeReport?: () => Promise<void>) {
  return deliver(finishRemoteOAuth(transaction.state, transaction.cookie, alice.username, "synthetic-code", alice), "publishing-account-oauth-finish", beforeReport);
}
/** 读取最新账号状态，防止只验证页面或本机记录。 */
async function accountStatus(id: string) { return (await agentPublishingAccounts(agentId)).find(account => account.id === id)?.status; }
/** 已连接账号用于隔离HTTP重试测试；凭据仅写入本例加密目录。 */
async function seededAccount() {
  const account = await createPublishingAccount(alice, agentId, "main", "Synthetic HTTP recovery");
  await claimPublishingAccount(agentId, account.id, "main", channelId, "Synthetic channel", true, Date.now());
  await executor.publishingAccounts.begin(account.id, "main", alice.username);
  const storage = executor.publishingAccounts.store(account.id);
  await storage.write("account.json", { id: account.id, instanceId: "main", channelId, channel: "Synthetic channel", connectedAt: Date.now(), channelCheckedAt: Date.now() });
  await storage.write("youtube.enc", seal({ accessToken: "synthetic-original-access", refreshToken: "synthetic-original-refresh", expiresAt: Date.now() + 3600_000, channelId, channel: "Synthetic channel" }));
  return account;
}
/** 固定真实Runner检查点及其Cloud工作记录；已上传视频无需读取或发送任何素材字节。 */
async function checkpoint(accountId: string) {
  const spec: JobSpec = fixtureJob(); spec.profile = { ...spec.profile, agentId, accountId, channelId };
  const state = await publishingStore().read<{ jobs: VideoJob[] }>("state.json"); state!.jobs.push({ spec, createdAt: Date.now() }); await publishingStore().write("state.json", state);
  const storage = new PublishingStore(path.join(root, "restarted-runner"));
  await storage.write("entries.enc", seal([{ spec, report: { id: spec.id, revision: 1, sequence: 1, state: "processing", videoId: "video_original", offset: spec.asset.size, total: spec.asset.size, updatedAt: Date.now(), metadata: { title: "Synthetic", description: "Description" } }, playlistsDone: [], failures: 0 }]));
  recoveryRunner = new PublishingRunner(executor.services, { store: storage, accountAuth: id => executor.publishingAccounts.auth(id) });
  return { spec, runner: recoveryRunner };
}

/** 八次真实短RPC还包括轮询和持久写入；仅本组合用例给20秒总预算，不改变任何单次任务期限。 */
it("combines genuine needs/epoch OAuth recovery with the original Runner video checkpoint", async () => {
  const account = await createPublishingAccount(alice, agentId, "main", "First OAuth"); await finish(await begin(account.id));
  expect(await accountStatus(account.id)).toBe("connected");
  const { spec, runner } = await checkpoint(account.id), oldBrowser = await begin(account.id);
  reads = "always-401"; refreshInvalid = true;
  await runner.tick(); const [failed] = await runner.reports();
  expect(failed).toMatchObject({ state: "needs_attention", authorizationInvalid: true, videoId: "video_original" });
  await reportPublishing(agentId, [failed]); expect(await accountStatus(account.id)).toBe("needs_reauthorization");
  await expect(admitYouTube(agentId, { attemptId: randomUUID(), clientFingerprint: createHash("sha256").update(clientId).digest("hex"), instanceId: "main", accountId: account.id, method: "videos.list", purpose: "publishing", trigger: "publishing-tick", jobId: spec.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  reads = "ok"; refreshInvalid = false;
  await finish(oldBrowser); expect(await accountStatus(account.id)).toBe("needs_reauthorization");
  const firstRecovery = await begin(account.id), newerFailure = { ...failed, sequence: failed.sequence + 1 };
  await finish(firstRecovery, async () => { await reportPublishing(agentId, [newerFailure]); });
  expect(await accountStatus(account.id)).toBe("needs_reauthorization");
  await finish(await begin(account.id), async () => { await reportPublishing(agentId, [newerFailure]); });
  expect(await accountStatus(account.id)).toBe("connected");
  const resumed = await changePublishingJob(alice, spec.id, "resume"); await runner.apply(resumed.spec); await runner.tick();
  const [report] = await runner.reports();
  expect(report).toMatchObject({ id: spec.id, revision: 2, state: "processing", videoId: "video_original", offset: spec.asset.size, total: spec.asset.size });
  expect(report.authorizationInvalid).toBeUndefined(); expect(resumed.spec.asset).toEqual(spec.asset); expect(resumed.spec.profile).toEqual(spec.profile);
  expect(attempts.some(attempt => ["videos.insert", "videos.upload.chunk"].includes(attempt.method))).toBe(false);
  expect(attempts.filter(attempt => attempt.method === "channels.list").every(attempt => !!attempt.operationId && !attempt.jobId && attempt.accountId === account.id)).toBe(true);
}, 20_000);

it.each([false, true])("GET401 re-read has its own Cloud admission and honors a second-read block=%s", async blocked => {
  const account = await seededAccount(); reads = "first-401";
  if (blocked) await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 8499, uploads: 0, source: "conservative-estimate" } }, admin.username);
  const api = new VideoApi(executor.publishingAccounts.auth(account.id), undefined, { instanceId: "main", accountId: account.id, purpose: "interactive", trigger: "metadata" });
  if (blocked) await expect(api.list(["video_original"])).rejects.toMatchObject({ code: "YOUTUBE_PROTECTION_WAIT", blockReason: "YOUTUBE_BUDGET" });
  else expect(await api.list(["video_original"])).toMatchObject([{ id: "video_original" }]);
  expect(attempts.map(attempt => attempt.method)).toEqual(["videos.list", "oauth.token", "videos.list"]);
  expect(new Set(attempts.map(attempt => attempt.attemptId)).size).toBe(3); expect(videoReads).toBe(blocked ? 1 : 2);
  await runtime.flush(); const day = youtubeDay(await readYouTubeUsage()), receipts = Object.values(day.receipts);
  expect(receipts.filter(receipt => receipt.input.method === "videos.list")).toHaveLength(blocked ? 1 : 2);
  expect(receipts.find(receipt => receipt.input.method === "oauth.token")?.result?.outcome).toBe("succeeded");
  expect(day.units).toBe(blocked ? 1 : 2); expect(await accountStatus(account.id)).toBe("connected");
});

it.each(["insert", "probe"] as const)("%s401 refreshes once without replaying the original write", async kind => {
  const account = await seededAccount(); rejectWrite = true;
  const legacyCharge = vi.fn(async () => {});
  const api = new VideoApi(executor.publishingAccounts.auth(account.id), legacyCharge, { instanceId: "main", accountId: account.id, purpose: "interactive", trigger: "metadata" });
  const spec = fixtureJob(); spec.profile = { ...spec.profile, agentId, accountId: account.id, channelId };
  const operation = kind === "insert" ? api.begin(spec, "synthetic-marker") : api.probe("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic", spec.asset.size);
  await expect(operation).rejects.toMatchObject({ code: "VIDEO_AUTH_REFRESHED", retryable: true });
  expect(attempts.map(attempt => attempt.method)).toEqual([kind === "insert" ? "videos.insert" : "videos.upload.probe", "oauth.token"]);
  expect(google).toHaveBeenCalledTimes(2); expect(legacyCharge).not.toHaveBeenCalled();
  expect(await executor.publishingAccounts.auth(account.id).tokens()).toMatchObject({ accessToken: "synthetic-access-1", channelId });
  const day = youtubeDay(await readYouTubeUsage()); expect(Object.keys(day.receipts)).toHaveLength(2); expect(day.uploads).toBe(kind === "insert" ? 1 : 0);
});
