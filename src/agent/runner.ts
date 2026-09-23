/** 桌面 Agent 生命周期复用既有执行器与协议，任务排空后退出。 */
import { heartbeatFeedback, acknowledgeFeedback } from "./feedback";
import { makeProblem, type Problem } from "../shared/problems";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "@/core/storage";
import { config, dataRoot, instanceDescriptors } from "@/core/config";
import { claimHost } from "@/core/ownership";
import { AppError, safeError, sleep } from "@/core/errors";
import { HEARTBEAT_MS, PROTOCOL, taskSchema, type AgentSnapshot } from "@/shared/remote";
import { Executor } from "./executor";
import { Worker } from "./worker";
import { Transport } from "./transport";
export type Identity = { agentId: string; origin: string; token: string };
export type AgentHooks = { stopped(): boolean; snapshots?(value: AgentSnapshot[]): void; connected?(transport: Transport): Promise<void>; heartbeat?(): void; problems?(value: Problem[]): void; error?(message: string, code?: string): void };
/** 保留既有会话、心跳、去重与完整业务执行语义；桌面只获得受限状态回报。 */
export async function runAgent(identity: Identity, hooks: AgentHooks) {
  if (identity.origin !== config().origin) throw new AppError("CONFIG", "控制端地址与配对记录不一致。");
  claimHost(); const transport = new Transport(identity.origin, identity.agentId, identity.token);
  const executor = new Executor(transport); const worker = new Worker(new Store(path.join(dataRoot(), "agent", "tasks")), task => executor.execute(task));
  const health = new Map<string, Problem>();
  const bootId = randomUUID(); const snapshots = new Map<string, AgentSnapshot>(); let connected = false;
  const readers = instanceDescriptors().map(async instance => { while (!hooks.stopped()) { try { snapshots.set(instance.id, await executor.snapshot(instance.id)); health.delete(instance.id); hooks.snapshots?.([...snapshots.values()]); } catch { health.set(instance.id, makeProblem("SNAPSHOT_READ", "此实例状态读取失败，保留最后一次成功快照供核对。", {source:"agent",target:{instanceId:instance.id},stage:"读取实例状态"})); } await sleep(HEARTBEAT_MS); } });
  const heartbeat = (async () => { while (!hooks.stopped()) {
    if (connected) try { const result = await transport.post<{ acknowledged: string[] }>("/api/agent/heartbeat", await heartbeatFeedback(worker, [...snapshots.values()], health, transport.structuredProblems)); await acknowledgeFeedback(worker, result.acknowledged, health); hooks.heartbeat?.(); }
    catch (error) { if (error instanceof AppError && [401, 409].includes(error.status)) connected = false; hooks.error?.(safeError(error), error instanceof AppError ? error.code : undefined); }
    hooks.problems?.([...health.values(), ...worker.problems.values()]);
    await sleep(HEARTBEAT_MS);
  } })();
  let delay = 1000;
  while (!hooks.stopped()) {
    try {
      if (!connected) {
        const session = await transport.post<{ session: string; capabilities?: string[] }>("/api/agent/session", { protocol: PROTOCOL, bootId, instances: instanceDescriptors(), ...(process.env.LIVENEST_MAINTENANCE ? { maintenance: process.env.LIVENEST_MAINTENANCE } : {}) });
        delete process.env.LIVENEST_MAINTENANCE;
        transport.session = session.session; transport.structuredProblems = !!session.capabilities?.includes("problem-v1"); await hooks.connected?.(transport); await executor.registerChannels(); connected = true;
      }
      const result = await (await transport.request("/api/agent/poll")).json() as { tasks: unknown[] };
      // 普通离线退出不依赖维护锁；逐条检查停止标志，已投递但未接收的任务留待云端核对。
      for (const raw of result.tasks) { if (hooks.stopped()) break; const task = taskSchema.parse(raw); if (task.agentId !== identity.agentId) throw new AppError("AGENT", "任务设备不匹配。", 403); await worker.receive(task); }
      delay = 1000; if (result.tasks.length) await sleep(500);
    } catch (error) { connected = false; hooks.error?.(safeError(error), error instanceof AppError ? error.code : undefined); await sleep(delay); delay = Math.min(30_000, delay * 2); }
  }
  await worker.drain(); await Promise.all([...readers, heartbeat]);
}
