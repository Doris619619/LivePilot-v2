/** Windows Agent 命令行入口；配对保留原凭据，运行复用桌面相同的配额保护与退出流程。 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Store } from "@/core/storage";
import { dataRoot, config } from "@/core/config";
import { AppError, safeError } from "@/core/errors";
import { PROTOCOL } from "@/shared/remote";
import { Transport, controllerOrigin } from "./transport";
import { runAgent, type Identity } from "./runner";
/** 专用配置只在进程启动加载，不覆盖已有环境或输出配置值。 */
function loadEnvironment() { const file = process.env.LIVEPILOT_ENV_FILE || ".env.agent"; if (existsSync(file)) process.loadEnvFile(file); }
/** 保留原配对文件；运行仅使用统一生命周期，避免 CLI 遗漏预算或日志保护。 */
async function main() {
  loadEnvironment();
  const credentials = new Store(path.join(dataRoot(), "agent"));
  const action = process.argv[2] || "run";
  if (action === "pair") {
    const agentId = process.env.LIVEPILOT_AGENT_ID || ""; const origin = controllerOrigin(config().origin);
    const existing = await credentials.read<Identity>("identity.json");
    if (existing && (existing.agentId !== agentId || existing.origin !== origin)) throw new AppError("CONFIG", "当前数据目录已属于其他设备或控制端，请保留原配置。");
    const identity = existing || { agentId, origin, token: randomBytes(32).toString("hex") };
    await credentials.write("identity.json", identity);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("输入云端生成的一次性配对码：")).trim(); rl.close();
    await new Transport(origin, agentId, identity.token).post("/api/agent/pair", { agentId, code, token: identity.token, protocol: PROTOCOL });
    console.log("配对成功。请运行 agent:start；首次运行前停止旧本地服务。"); return;
  }
  if (action !== "run") throw new AppError("INPUT", "用法：agent pair 或 agent run。");
  const identity = await credentials.read<Identity>("identity.json");
  if (!identity) throw new AppError("CONFIG", "请先完成设备配对。");
  let stopped = false;
  process.once("SIGINT", () => { stopped = true; }); process.once("SIGTERM", () => { stopped = true; });
  await runAgent(identity, { stopped: () => stopped, error: message => console.error(message) });
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
