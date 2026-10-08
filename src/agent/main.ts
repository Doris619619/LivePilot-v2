/** Windows Agent 命令行入口；配置加载和任务运行均不依赖 Next.js。 */
import { heartbeatFeedback, acknowledgeFeedback } from "./feedback";
import { makeProblem, type Problem } from "../shared/problems";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Store } from "@/core/storage";
import { instanceDescriptors, dataRoot, config } from "@/core/config";
import { claimHost } from "@/core/ownership";
import { AppError, safeError, sleep } from "@/core/errors";
import { HEARTBEAT_MS, PROTOCOL, taskSchema, type AgentSnapshot } from "@/shared/remote";
import { Transport, controllerOrigin } from "./transport";
import { Executor } from "./executor";
import { syncLiveChatEnvironment } from "./live-chat-environment";
import { Worker } from "./worker";
/** 在启动阶段读取专用配置；不覆盖已存在环境，不在日志输出配置值。 */
function loadEnvironment() { const file = process.env.LIVEPILOT_ENV_FILE || ".env.agent"; if (existsSync(file)) process.loadEnvFile(file); }
/** 以本地持久凭据连接，浏览器永远接触不到设备 token。 */
async function main() {
  loadEnvironment();
  const credentials = new Store(path.join(dataRoot(), "agent"));
  const action = process.argv[2] || "run";
  if (action === "pair") {
    const agentId = process.env.LIVEPILOT_AGENT_ID || ""; const origin = controllerOrigin(config().origin);
    const existing = await credentials.read<{ agentId: string; origin: string; token: string }>("identity.json");
    if (existing && (existing.agentId !== agentId || existing.origin !== origin)) throw new AppError("CONFIG", "当前数据目录已属于其他设备或控制端，请保留原配置。");
    const identity = existing || { agentId, origin, token: randomBytes(32).toString("hex") };
    await credentials.write("identity.json", identity);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("输入云端生成的一次性配对码：")).trim(); rl.close();
    const transport = new Transport(origin, agentId, identity.token);
    await transport.post("/api/agent/pair", { agentId, code, token: identity.token, protocol: PROTOCOL });
    console.log("配对成功。请运行 agent:start；首次运行前停止旧本地服务。"); return;
  }
  if (action !== "run") throw new AppError("INPUT", "用法：agent pair 或 agent run。");
  const identity = await credentials.read<{ agentId: string; origin: string; token: string }>("identity.json");
  if (!identity) throw new AppError("CONFIG", "请先完成设备配对。");
  if (identity.origin !== config().origin) throw new AppError("CONFIG", "控制端地址与配对记录不一致，请恢复原配置。");
  claimHost();
  const transport = new Transport(identity.origin, identity.agentId, identity.token); const executor = new Executor(transport);
  const worker = new Worker(new Store(path.join(credentials.dir, "tasks")), task => executor.execute(task), identity.agentId);
  executor.purgeYouTubeTasks = (id, accountId) => worker.purgeYouTube(id, accountId);
  const health = new Map<string, Problem>();
  const bootId = randomUUID(); const snapshots = new Map<string, AgentSnapshot>(); let stopped = false; let connected = false;
  process.once("SIGINT", () => { stopped = true; }); process.once("SIGTERM", () => { stopped = true; });
  /** 每实例独立采样，慢 OBS 不影响其他实例和心跳。 */
  const readers = instanceDescriptors().map(async instance => { while (!stopped) { try { snapshots.set(instance.id, await executor.snapshot(instance.id)); health.delete(instance.id); } catch { health.set(instance.id, makeProblem("SNAPSHOT_READ", "此实例状态读取失败，保留最后一次成功快照供核对。", {source:"agent",target:{instanceId:instance.id},stage:"读取实例状态"})); } await sleep(HEARTBEAT_MS); } });
  /** 结果与心跳独立于长轮询；网络错误不会取消正在执行的任务。 */
  const heartbeat = (async () => { while (!stopped) {
    if (connected) try {
      const result = await transport.post<{ acknowledged: string[] }>("/api/agent/heartbeat", await heartbeatFeedback(worker, [...snapshots.values()], health, transport.structuredProblems));
      await acknowledgeFeedback(worker, result.acknowledged, health);
    } catch (error) { if (error instanceof AppError && error.status === 401) connected = false; }
    await sleep(HEARTBEAT_MS);
  } })();
  let delay = 1000;
  while (!stopped) {
    try {
      if (!connected) {
        const session = await transport.post<{ session: string; protocol: number; capabilities?: string[] }>("/api/agent/session", { protocol: PROTOCOL, bootId, instances: instanceDescriptors(), capabilities: ["publishing-v1", "publishing-v2", "publishing-accounts-v1"] });
        transport.session = session.session; transport.structuredProblems = !!session.capabilities?.includes("problem-v1"); await executor.registerChannels(); connected = true;
        if (session.capabilities?.includes("live-chat-v1")) await syncLiveChatEnvironment(transport, executor.services.values()).catch(() => { /* 聊天环境故障不阻断既有广播控制；缺配置由聊天状态提示。 */ });
        executor.startChat();
        executor.connectPublishing(!!session.capabilities?.includes("publishing-v1"), !!session.capabilities?.includes("publishing-accounts-v1"));
        await transport.post("/api/agent/heartbeat", await heartbeatFeedback(worker, [...snapshots.values()], health, transport.structuredProblems));
      }
      const response = await transport.request("/api/agent/poll"); const result = await response.json() as { tasks: unknown[] };
      for (const raw of result.tasks) { const task = taskSchema.parse(raw); if (task.agentId !== identity.agentId) throw new Error("Invalid target"); await worker.receive(task); }
      delay = 1000; if (result.tasks.length) await sleep(500);
    } catch (error) {
      connected = false; console.error(safeError(error)); await sleep(delay); delay = Math.min(30_000, delay * 2);
    }
  }
  await executor.stopChat(); await worker.drain(); await executor.stopPublishing(); await Promise.all([...readers, heartbeat]);
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
