/** 云端本机管理入口：创建设备配对码、列出设备或撤销凭据。 */
import { existsSync } from "node:fs";
import { createPairing, listAgents, revokeAgent } from "./agents";
import { reconcileRemovedChannelBindings } from "./bindings";
import { AppError, safeError } from "@/core/errors";
/** 管理命令只读取当前部署配置；不会把环境和设备凭据打印到日志。 */
async function main() {
  const envFile = process.env.LIVEPILOT_ENV_FILE || ".env.local"; if (existsSync(envFile)) process.loadEnvFile(envFile);
  const [action, id, name] = process.argv.slice(2);
  if (action === "pair") { const result = await createPairing(id, name || id); console.log(`设备：${result.agentId}\n一次性配对码（10 分钟有效，仅交给这台电脑）：${result.code}`); }
  else if (action === "list") { for (const agent of await listAgents()) console.log(`${agent.id}\t${agent.name}\t${agent.revoked ? "已撤销" : agent.online ? "在线" : "离线"}\t${agent.instances.map(i => i.id).join(",")}`); }
  else if (action === "revoke") { await revokeAgent(id); console.log("设备已移除，频道占用已释放；已接收任务和 OBS 不会因此停止。"); }
  else if (action === "release-removed-channels") console.log("已释放已移除设备的频道占用：" + await reconcileRemovedChannelBindings());
  else throw new AppError("INPUT", "用法：agent:admin -- pair <设备ID> [名称] | list | revoke <设备ID> | release-removed-channels");
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
