/** 把白名单远程任务交给本机完整直播流程；禁止远程 shell 和任意路径。 */
import { aiStatus, saveAiKey, generateCopy } from "@/core/broadcast-ai";
import { saveThumbnail } from "@/core/broadcast-assets";
import { Store } from "@/core/storage";
import { config } from "@/core/config";
import { Service } from "@/core/service";
import { instanceIds, instanceDescriptors, validateInstances } from "@/core/config";
import { saveChannelBinding } from "@/core/youtube/bindings";
import * as uploads from "@/core/uploads";
import { AppError } from "@/core/errors";
import { sleep } from "@/core/errors";
import { randomUUID } from "node:crypto";
import { PublishingRunner } from "@/core/publishing/runner";
import { scanPublishingPackages, publishingRoot } from "@/core/publishing/packages";
import { scanPublishingAssets, scanPublishingThumbnails } from "@/core/publishing/assets";
import { PublishingStore } from "@/core/publishing/storage";
import { PublishingAccounts } from "@/core/publishing/accounts";
import type { RemoteTask, AgentSnapshot } from "@/shared/remote";
import type { Transport } from "./transport";
import type { PublishingAccount } from "@/shared/publishing";
import { audit } from "@/core/audit";
export class Executor {
  readonly services = new Map<string, Service>();
  readonly publishing: PublishingRunner;
  readonly publishingAccounts: PublishingAccounts;
  purgeYouTubeTasks?: (instanceId: string, accountId?: string) => Promise<void>;
  private observed = new Map<string, AgentSnapshot>();
  private publishingConnected = false; private publishingStopped = false; private publishingLoop?: Promise<void>;
  private accountsConnected = false;
  /** 每实例独立控制器；频道先在云端永久占用，再保存本机加密令牌。 */
  constructor(private transport: Transport) {
    validateInstances();
    for (const id of instanceIds()) this.services.set(id, new Service(id, async (instanceId, tokens) => {
      await transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: false });
      await saveChannelBinding(instanceId, tokens);
      await transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: true });
    }));
    this.publishingAccounts = new PublishingAccounts(async (accountId, instanceId, channel, confirm) => { await transport.post("/api/agent/publishing/accounts-binding", { accountId, instanceId, ...channel, confirm }); });
    this.publishing = new PublishingRunner(this.services, {
      accountAuth: accountId => this.publishingAccounts.auth(accountId),
      live: () => [...this.observed.values()].some(s => s.observedAt > Date.now() - 20_000 && (s.dashboard.obs.streaming === true || s.dashboard.youtube.lifecycle === "live" || s.dashboard.obs.reconnecting === true)),
      charge: async (job, units, upload) => { await this.transport.post("/api/agent/publishing/quota", { id: job.id, receipt: randomUUID(), units, upload }); },
    });
  }
  /** 独立于心跳和旧 Worker 启动后台循环；旧 Cloud 不声明能力时不调用新路由。 */
  connectPublishing(enabled: boolean, accountsEnabled = false) {
    this.publishingConnected = enabled;
    this.accountsConnected = accountsEnabled;
    if (this.publishingLoop || !enabled) return;
    this.publishingLoop = (async () => { while (!this.publishingStopped) { if (this.publishingConnected) try {
      const accounts = this.accountsConnected ? await this.publishingAccounts.statuses() : undefined;
      const result = await this.transport.post<{ acknowledged: { id: string; sequence: number }[]; cleanups: { id: string; instanceId: string; accountId?: string; createdAt: number }[]; accounts?: PublishingAccount[] }>("/api/agent/publishing/sync", { reports: await this.publishing.reports(), busy: this.publishing.busy || this.publishingAccounts.busy, ...(accounts ? { accounts } : {}) });
      await this.publishing.acknowledge(result.acknowledged);
      // Cloud 已确认删除而本机完成落盘/HTTP 响应丢失时，以永久 deleted 记录恢复清理确认。
      for (const account of result.accounts || []) if (account.status === "deleted" && accounts?.some(local => local.id === account.id && (local.cleanupPending || local.channelId))) { try { await this.cleanPublishingAccount(account.id, account.instanceId, account.deletedAt || account.updatedAt); } catch { /* 本机清理仍持久保留，下轮重试。 */ } }
      for (const cleanup of result.cleanups) {
        if (cleanup.accountId) {
          try { await this.cleanPublishingAccount(cleanup.accountId, cleanup.instanceId, cleanup.createdAt, cleanup.id); } catch { /* 一个账号的撤销失败不能阻塞其他账号上传；Cloud 保持待清理。 */ }
          continue;
        }
        const store = new PublishingStore(config(cleanup.instanceId).dataDir);
        await store.write("publishing-purge.json", { createdAt: cleanup.createdAt, pending: true });
        await this.publishing.purge(cleanup.instanceId);
        const app = this.services.get(cleanup.instanceId); if (!app) throw new AppError("INSTANCE", "待清理实例不存在。");
        await this.purgeYouTubeTasks?.(cleanup.instanceId);
        await app.commands.withIdle(() => app.control.exclusive(async () => {
          await app.auth.revoke();
          const state = await app.control.state();
          for (const key of ["channelId", "broadcastId", "streamId", "broadcastTitle", "streamTitle"] as const) delete state[key];
          await store.write("control.json", state);
        })); app.invalidate(); this.observed.delete(cleanup.instanceId);
        await this.transport.post("/api/agent/publishing/cleanup", { id: cleanup.id });
        await store.write("publishing-purge.json", { createdAt: cleanup.createdAt, pending: false });
      }
      await this.publishing.tick();
    } catch { /* 发布错误由持久状态回报；不污染心跳或输出上游请求。 */ } await sleep(1000); } })();
  }
  /** 仅停止并撤销指定发布账号；同意撤销先落盘，Cloud 接收确认后保存不可复用的删除事实。 */
  private async cleanPublishingAccount(accountId: string, instanceId: string, createdAt: number, requestId?: string) { await this.publishingAccounts.startCleanup(accountId, instanceId, createdAt); await this.publishing.purge(instanceId, accountId); await this.purgeYouTubeTasks?.(instanceId, accountId); await this.publishingAccounts.revoke(accountId); if (requestId) await this.transport.post("/api/agent/publishing/cleanup", { id: requestId }); await this.publishingAccounts.completeCleanup(accountId); }
  /** 退出时安全中断长上传；保留加密检查点供下次恢复。 */
  async stopPublishing() { this.publishingStopped = true; await this.publishing.stop(); await this.publishingLoop; await this.publishingAccounts.drain(); }
  /** 频道归属完成登记后启动一次；连接中断不取消已经启用的本机聊天。 */
  startChat() { for (const app of this.services.values()) app.chat.start(); }
  /** 退出时先取消流和生成；聊天落盘失败由聊天状态报告，仍排空控制与发布任务。 */
  async stopChat() { await Promise.allSettled([...this.services.values()].map(app => app.chat.stop())); }
  /** 接入前登记已有频道，跨电脑重复授权不能开始接收控制任务。 */
  async registerChannels() {
    for (const [instanceId, app] of this.services) {
      const tokens = await app.auth.tokens();
      if (tokens) await this.transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: true });
    }
    // 独立账号在发布 sync 中核对；已删除或待清理账号不能阻断这台设备的既有直播连接。
  }
  /** 本机状态读取不阻塞通信心跳；读取耗时由 observedAt 明确表示。 */
  async snapshot(id: string): Promise<AgentSnapshot> {
    const app = this.services.get(id)!; const instance = instanceDescriptors().find(i => i.id === id)!;
    const observedAt = Date.now(); const snapshot = { instance, dashboard: await app.dashboard(), observedAt }; this.observed.set(id, snapshot); return snapshot;
  }
  /** 上传与控制独立执行；同实例控制仍由 Commands/Control 锁保护。 */
  async execute(task: RemoteTask): Promise<unknown> {
    if (task.agentId !== this.transport.agentId) throw new AppError("AGENT", "任务不属于这台设备。", 403);
    const app = this.services.get(task.instanceId); if (!app) throw new AppError("INSTANCE", "实例不存在。", 404);
    const p = task.payload;
    if (p.kind === "live-chat-read") return app.chat.status();
    if (p.kind === "live-chat-configure") {
      const result = await app.chat.configure(p.config);
      await audit(task.actor, "live-chat-configure", task.instanceId, "succeeded", task.id);
      return result;
    }
    const accountScoped = p.kind === "publishing-apply" ? !!p.job.profile.accountId : "accountId" in p && !!p.accountId;
    const clearing = await new Store(config(task.instanceId).dataDir).read<{ pending?: boolean }>("publishing-purge.json");
    if (clearing?.pending && !accountScoped && (p.kind.startsWith("publishing-") || p.kind.startsWith("oauth-") || ["broadcast-read", "broadcast-playlists"].includes(p.kind) || p.kind === "control" && p.input.action === "start")) throw new AppError("CLEANUP", "设备正在清理授权，请完成后重新连接频道。"); const actor = task.actor; const id = task.instanceId;
    if (p.kind === "publishing-account-oauth-begin") return this.publishingAccounts.begin(p.accountId, id, actor);
    if (p.kind === "publishing-account-oauth-finish") return this.publishingAccounts.finish(p.accountId, id, p.cookie, p.state, p.code, actor, p.expectedChannel || await this.publishing.expectedChannel(id, p.accountId), p.cancelled);
    if (p.kind === "publishing-account-playlists") return this.publishingAccounts.playlists(p.accountId, id);
    if (p.kind === "publishing-packages") { if (p.accountId) await this.publishingAccounts.assertAvailable(p.accountId, id); const token = await (p.accountId ? this.publishingAccounts.auth(p.accountId) : app.auth).tokens(); return { ...await scanPublishingPackages(publishingRoot()), thumbnails: await scanPublishingThumbnails(config(id).mediaRoot), ...(token ? { channelId: token.channelId, channel: token.channel } : {}) }; }
    if (p.kind === "publishing-archive") return this.publishing.archiveBatch(p.batch, p.archiveId);
    if (p.kind === "publishing-assets") { if (p.accountId) await this.publishingAccounts.assertAvailable(p.accountId, id); const token = await (p.accountId ? this.publishingAccounts.auth(p.accountId) : app.auth).tokens(); const index = await scanPublishingAssets(config(id).mediaRoot); const hashes = await this.publishing.assetHashes(id); return { ...index, assets: index.assets.map(a => hashes[a.version] ? { ...a, sha256: hashes[a.version], hashState: "verified" } : a), ...(token ? { channelId: token.channelId, channel: token.channel } : {}) }; }
    if (p.kind === "publishing-apply") {
      if (p.job.profile.agentId !== task.agentId || p.job.profile.instanceId !== task.instanceId || p.job.actor !== actor) throw new AppError("TARGET", "发布指令与任务目标不一致。", 403);
      if (p.job.profile.accountId) { await this.publishingAccounts.assertAvailable(p.job.profile.accountId, id, p.job.consent.acceptedAt); return this.publishing.apply(p.job); }
      const purge = await new Store(config(id).dataDir).read<{ createdAt: number }>("publishing-purge.json");
      if (purge && p.job.consent.acceptedAt <= purge.createdAt) throw new AppError("CONSENT", "此发布授权已被撤销，请重新确认新批次。");
      return this.publishing.apply(p.job);
    }
    if (p.kind === "broadcast-ai-status") return aiStatus(new Store(config(id).dataDir));
    if (p.kind === "broadcast-ai-key") return saveAiKey(new Store(config(id).dataDir), p.apiKey);
    if (p.kind === "broadcast-ai-generate") return generateCopy(new Store(config(id).dataDir), p.brief);
    if (p.kind === "broadcast-playlists") return { playlists: await app.youtube.playlists() };
    if (p.kind === "broadcast-thumbnail") return saveThumbnail(new Store(config(id).dataDir), p.input);
    if (p.kind === "control") {
      const result = await app.commands.accept({ requestId: task.id, instanceId: id, ...p.input }, actor);
      if (result.fresh) await app.commands.run(task.id);
      const operation = await app.commands.get(task.id);
      if (operation?.status !== "succeeded") throw new AppError("CONTROL", operation?.message || "操作未完成，请核对实际状态。", 409, operation?.problem);
      return operation;
    }
    if (p.kind === "oauth-begin") return app.commands.withIdle(() => app.control.exclusive(() => app.auth.begin(actor)));
    if (p.kind === "oauth-finish") {
      await app.commands.withIdle(() => app.control.exclusive(async () => { const state = await app.control.state(); await app.auth.finish(p.cookie, p.state, p.code, !["stopped", "idle"].includes(state.phase) && state.channelId ? state.channelId : await this.publishing.expectedChannel(id), actor); }));
      await app.refreshChatCredentials(); return { ok: true };
    }
    if (p.kind === "upload-create") return uploads.createUpload(id, actor, p.input, p.uploadId);
    if (p.kind === "upload-status") return uploads.uploadStatus(id, actor, p.uploadId);
    if (p.kind === "upload-cancel") { await uploads.cancelUpload(id, actor, p.uploadId); return { ok: true }; }
    if (p.kind === "upload-chunk") {
      const response = await this.transport.request("/api/agent/chunks/" + p.slot, {}, 90_000);
      const request = new Request("http://127.0.0.1/upload", { method: "PUT", body: response.body, duplex: "half" } as RequestInit);
      return uploads.uploadChunk(id, actor, p.uploadId, p.offset, p.hash, request);
    }
    await uploads.prepareFinish(id, actor, p.uploadId);
    try { return await uploads.finishUpload(id, actor, p.uploadId); }
    catch (error) { await uploads.uploadFailure(id, actor, p.uploadId, error); throw error; }
  }
}
