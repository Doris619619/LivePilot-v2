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
import type { RemoteTask, AgentSnapshot } from "@/shared/remote";
import type { Transport } from "./transport";
export class Executor {
  readonly services = new Map<string, Service>();
  /** 每实例独立控制器；频道先在云端永久占用，再保存本机加密令牌。 */
  constructor(private transport: Transport) {
    validateInstances();
    for (const id of instanceIds()) this.services.set(id, new Service(id, async (instanceId, tokens) => {
      await transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: false });
      await saveChannelBinding(instanceId, tokens);
      await transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: true });
    }));
  }
  /** 接入前登记已有频道，跨电脑重复授权不能开始接收控制任务。 */
  async registerChannels() {
    for (const [instanceId, app] of this.services) {
      const tokens = await app.auth.tokens();
      if (tokens) await this.transport.post("/api/agent/bindings", { instanceId, channelId: tokens.channelId, confirm: true });
    }
  }
  /** 本机状态读取不阻塞通信心跳；读取耗时由 observedAt 明确表示。 */
  async snapshot(id: string): Promise<AgentSnapshot> {
    const app = this.services.get(id)!; const instance = instanceDescriptors().find(i => i.id === id)!;
    const observedAt = Date.now(); return { instance, dashboard: await app.dashboard(), observedAt };
  }
  /** 上传与控制独立执行；同实例控制仍由 Commands/Control 锁保护。 */
  async execute(task: RemoteTask): Promise<unknown> {
    if (task.agentId !== this.transport.agentId) throw new AppError("AGENT", "任务不属于这台设备。", 403);
    const app = this.services.get(task.instanceId); if (!app) throw new AppError("INSTANCE", "实例不存在。", 404);
    const p = task.payload; const actor = task.actor; const id = task.instanceId;
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
      await app.commands.withIdle(() => app.control.exclusive(async () => { const state = await app.control.state(); await app.auth.finish(p.cookie, p.state, p.code, state.phase !== "stopped" ? state.channelId : undefined, actor); }));
      app.invalidate(); return { ok: true };
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
