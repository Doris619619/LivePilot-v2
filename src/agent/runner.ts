/** 桌面 Agent 生命周期复用既有执行器与协议，任务排空后退出。 */
import { heartbeatFeedback, acknowledgeFeedback } from "./feedback";
import { makeProblem, type Problem } from "../shared/problems";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "@/core/storage";
import { config, dataRoot, instanceDescriptors } from "@/core/config";
import { claimHost } from "@/core/ownership";
import { AppError, safeError, sleep } from "@/core/errors";
import { HEARTBEAT_MS, taskSchema, type AgentSnapshot } from "@/shared/remote";
import { Executor } from "./executor";
import { Worker } from "./worker";
import { Transport } from "./transport";
import { connectSession } from "./session";
import { syncLiveChatEnvironment, LiveChatEnvironmentSync } from "./live-chat-environment";
import { AgentYouTubeUsage } from "./youtube-usage";
import { installYouTubeRuntime } from "@/core/youtube/usage";
import { audit } from "@/core/audit";
export type Identity = { agentId: string; origin: string; token: string };
export type AgentHooks = { stopped(): boolean; snapshots?(value: AgentSnapshot[]): void; connected?(transport: Transport): Promise<void>; heartbeat?(): void; problems?(value: Problem[]): void; error?(message: string, code?: string): void; localStop?(callback: ((instanceId: string) => Promise<unknown>) | undefined): void };
/** 保留既有会话、心跳、去重与完整业务执行语义；桌面只获得受限状态回报。 */
export async function runAgent(identity: Identity, hooks: AgentHooks) {
  if (identity.origin !== config().origin) throw new AppError("CONFIG", "控制端地址与配对记录不一致。");
  claimHost(); const transport = new Transport(identity.origin, identity.agentId, identity.token);
  const executor = new Executor(transport); const worker = new Worker(new Store(path.join(dataRoot(), "agent", "tasks")), task => executor.execute(task), identity.agentId);
  executor.purgeYouTubeTasks = (id, accountId) => worker.purgeYouTube(id, accountId);
  const health = new Map<string, Problem>();
  const usage = new AgentYouTubeUsage(transport); installYouTubeRuntime(usage);
  /** 本机停止仅操作当前进程已持有的实例；不经 Cloud，不请求平台，不因日志失败阻断停止。 */
  hooks.localStop?.(async id => {
    const app = executor.services.get(id); if (!app) throw new AppError("INSTANCE", "本机实例不存在。", 404);
    const result = await app.control.stop({ localOnly: true });
    try { await audit("desktop-local", "stop-local", id, "succeeded"); } catch { /* OBS 已确认停止，独立审计失败不能反转停止事实。 */ }
    return result;
  });
  let accountAiSupported = false;
  const chatEnvironment = new LiveChatEnvironmentSync(() => syncLiveChatEnvironment(transport, executor.services.values(), accountAiSupported), failed => {
    if (failed) health.set("chat-environment", makeProblem("CHAT_ENVIRONMENT", "AI 互动配置同步失败，客户端正在自动重试。", { source: "agent", stage: "同步 AI 互动配置", outcome: "not-sent" }));
    else health.delete("chat-environment");
  });
  const bootId = randomUUID(); const snapshots = new Map<string, AgentSnapshot>(); let connected = false;
  const readers = instanceDescriptors().map(async instance => { while (!hooks.stopped()) { try { snapshots.set(instance.id, await executor.snapshot(instance.id)); health.delete(instance.id); hooks.snapshots?.([...snapshots.values()]); } catch { health.set(instance.id, makeProblem("SNAPSHOT_READ", "此实例状态读取失败，保留最后一次成功快照供核对。", {source:"agent",target:{instanceId:instance.id},stage:"读取实例状态"})); } await sleep(HEARTBEAT_MS); } });
  const heartbeat = (async () => { while (!hooks.stopped()) {
    if (connected) void chatEnvironment.refresh();
    if (connected) try { const result = await transport.post<{ acknowledged: string[] }>("/api/agent/heartbeat", await heartbeatFeedback(worker, [...snapshots.values()], health, transport.structuredProblems)); await acknowledgeFeedback(worker, result.acknowledged, health); hooks.heartbeat?.(); }
    catch (error) { if (error instanceof AppError && [401, 409].includes(error.status)) { connected = false; usage.disconnect(); } hooks.error?.(safeError(error), error instanceof AppError ? error.code : undefined); }
    if (connected) void usage.flush();
    void usage.maintain();
    if (usage.status().logFailed) health.set("youtube-log", makeProblem("YOUTUBE_LOG_STORAGE", "YouTube 调用日志暂时无法同步，部分记录可能不完整。", { source: "agent", domain: "youtube", stage: "同步调用日志" })); else health.delete("youtube-log");
    hooks.problems?.([...health.values(), ...worker.problems.values()]);
    await sleep(HEARTBEAT_MS);
  } })();
  let delay = 1000;
  while (!hooks.stopped()) {
    try {
      if (!connected) {
        const session = await connectSession(transport, { bootId, instances: instanceDescriptors(), ...(process.env.LIVENEST_MAINTENANCE ? { maintenance: process.env.LIVENEST_MAINTENANCE } : {}) });
        delete process.env.LIVENEST_MAINTENANCE;
        transport.session = session.session; transport.structuredProblems = !!session.capabilities?.includes("problem-v1"); await hooks.connected?.(transport); await executor.registerChannels(); connected = true;
        usage.connect(session.capabilities || []);
        if (executor.services.size && !usage.status().protected) health.set("youtube-protection", makeProblem("YOUTUBE_PROTECTION_OFFLINE", "控制端需升级配额保护协议，新的 YouTube 操作已暂停；已有 OBS 推流继续。", { source: "agent", domain: "youtube", stage: "连接配额保护" })); else health.delete("youtube-protection");
        accountAiSupported = !!session.capabilities?.includes("account-ai-v1");
        await chatEnvironment.stop();
        chatEnvironment.connect(!!session.capabilities?.includes("live-chat-v1"));
        await chatEnvironment.refresh();
        executor.startChat();
        executor.mediaPreview.connect(!!session.capabilities?.includes("media-preview-v1"));
        executor.connectPublishing(!!session.capabilities?.includes("publishing-v1"), !!session.capabilities?.includes("publishing-accounts-v1"), !!session.capabilities?.includes("publishing-auth-generation-v1"));
      }
      const result = await (await transport.request("/api/agent/poll")).json() as { tasks: unknown[] };
      // 普通离线退出不依赖维护锁；逐条检查停止标志，已投递但未接收的任务留待云端核对。
      for (const raw of result.tasks) { if (hooks.stopped()) break; const task = taskSchema.parse(raw); if (task.agentId !== identity.agentId) throw new AppError("AGENT", "任务设备不匹配。", 403); await worker.receive(task); }
      delay = 1000; if (result.tasks.length) await sleep(500);
    } catch (error) { connected = false; usage.disconnect(); hooks.error?.(safeError(error), error instanceof AppError ? error.code : undefined); await sleep(delay); delay = Math.min(30_000, delay * 2); }
  }
  hooks.localStop?.(undefined); usage.disconnect();
  await chatEnvironment.stop(); await executor.stopChat(); await worker.drain(); await executor.stopPublishing(); await usage.stop(); installYouTubeRuntime(undefined); await Promise.all([...readers, heartbeat]);
}
