/** 隔离 HTTP 验收运行时；测试频道身份与真实文件分开，不加载 Service 或连接 OBS/YouTube。 */
export * as browser from "../../src/app/api/media-preview/route";
export * as agent from "../../src/app/api/agent/[...path]/route";
export * as access from "../../src/server/access";
export * as agents from "../../src/cloud/agents";
export * as accounts from "../../src/cloud/publishing-accounts";
export * as packages from "../../src/core/publishing/packages";
import { Transport } from "../../src/agent/transport";
import { MediaPreviewConnection } from "../../src/agent/media-preview";
import { AgentPreviewSessions } from "../../src/core/preview/session";
import { PublishingRunner } from "../../src/core/publishing/runner";

import { AppError } from "../../src/core/errors";
/** 子进程使用独立 Agent 数据根，只接受当前验收的固定身份，不接收发布任务。 */
async function worker(input: { origin: string; agentId: string; token: string; accountId: string; bootId: string }) {
  const transport = new Transport(input.origin, input.agentId, input.token);
  const runner = new PublishingRunner(new Map());
  const preview = new MediaPreviewConnection(transport, new AgentPreviewSessions(runner, async target => {
    if (target.agentId !== input.agentId || target.instanceId !== "main" || target.accountId !== input.accountId || target.channelId !== "test_channel") throw new Error("Target mismatch");
  }));
  const result = await transport.post<{ session: string }>("/api/agent/session", { protocol: 1, bootId: input.bootId, instances: [{ id: "main", name: "Isolated preview" }], capabilities: ["media-preview-v1", "publishing-v2", "publishing-accounts-v1"] });
  transport.session = result.session;
  /** 心跳仅维持隔离设备在线，不注入 OBS 或 YouTube 状态。 */
  const heartbeat = () => transport.post("/api/agent/heartbeat", { protocol: 1, snapshots: [], reports: [] });
  await heartbeat(); const timer = setInterval(() => void heartbeat().catch(() => {}), 2000); preview.connect(true); process.send?.({ ready: true });
  process.on("message", async (message: { stop?: boolean }) => { if (message.stop) { clearInterval(timer); await preview.stop(); const reports = await runner.reports(); await runner.stop(); process.send?.({ stopped: true, uploads: reports.length }); process.exit(0); } });
}
if (process.argv[2] === "worker") process.once("message", input => { void worker(input as Parameters<typeof worker>[0]).catch(error => { process.send?.({ failed: true, reason: error instanceof AppError ? error.code + ": " + error.message : "Runtime initialization failed" }); process.exit(1); }); });
