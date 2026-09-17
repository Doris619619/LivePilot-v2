/** 统一前台/计划任务入口：子进程启动前加载配置，使 Node 代理设置及时生效。 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
/** 子进程直接继承交互终端和退出信号，设备密钥不会出现在参数列表。 */
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major === 22 && minor >= 23 || major >= 24)) throw new Error("请安装 Node 22.23+ 或 24+，以支持代理启动参数。");
  const action = process.argv[2] || "run"; if (!["run", "pair"].includes(action)) throw new Error("用法：agent-launch.mjs run|pair");
  const envFile = path.resolve(process.env.LIVEPILOT_ENV_FILE || path.join(root, ".env.agent"));
  await access(envFile); await access(path.join(root, "dist/agent.cjs"));
  const child = spawn(process.execPath, [`--env-file=${envFile}`, "--use-env-proxy", path.join(root, "dist/agent.cjs"), action], { cwd: root, stdio: "inherit", env: { ...process.env, LIVEPILOT_ENV_FILE: envFile } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("error", () => { console.error("无法启动 Agent，请检查 Node 与构建产物。"); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
void main().catch(() => { console.error("Agent 启动失败：需要 Node 22.23+/24+、.env.agent 和 npm run agent:build。请查看部署文档。"); process.exitCode = 1; });
