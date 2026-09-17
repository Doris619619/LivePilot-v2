/** 初始化 cloud/agent 私有配置并生成 Google 回调清单；不覆盖已有文件。 */
import path from "node:path";
import { parseArgs } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { agentValues, cloudValues, createEnv, readEnv, oauthSettings } from "./deployment/config.mjs";
/** 以显式参数选择配置，旧本机迁移不改变数据根和加密密钥。 */
async function main() {
  const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { domain: { type: "string" }, id: { type: "string" }, from: { type: "string" }, proxy: { type: "string" }, help: { type: "boolean" } } });
  if (a.help) { console.log("npm run setup:cloud -- --domain live.example.com\nnpm run setup:agent -- --domain live.example.com --id studio_a [--from .env.local] [--proxy http://127.0.0.1:7890]"); return; }
  const mode = positionals[0]; if (!["cloud", "agent"].includes(mode)) throw new Error("模式必须为 cloud 或 agent。");
  const file = mode === "cloud" ? ".env.cloud" : ".env.agent";
  // 已配对设备不能通过初始化命令换身份；已有文件一律保留。
  try { await access(file); console.log(`${file} 已存在，完整保留；请运行 doctor 检查。`); return; } catch (e) { if (e.code !== "ENOENT") throw e; }
  let values;
  if (mode === "cloud") values = cloudValues(a.domain);
  else {
    const prior = await readEnv(a.from || "config/agent.env.example");
    if (a.from && !prior.LIVEPILOT_ENCRYPTION_KEY) throw new Error("旧配置缺少加密密钥，拒绝自动生成替换旧密钥。");
    const data = path.resolve(prior.LIVEPILOT_DATA_ROOT || ".data");
    try { await access(path.join(data, "agent", "identity.json")); throw new Error("数据目录已配对，请恢复原 .env.agent；不要初始化另一个身份。"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!a.from) { for (const name of ["youtube.enc", "control.json", "instances"]) { try { await access(path.join(data, name)); throw new Error("检测到旧运行数据，请使用 --from 原配置，保留密钥。"); } catch (e) { if (e.code !== "ENOENT") throw e; } } }
    values = agentValues(a.domain, a.id, prior, a.proxy);
  }
  if (!await createEnv(file, values)) { console.log(`${file} 已由其他初始化创建，完整保留。`); return; }
  await mkdir(".data/setup", { recursive: true });
  await writeFile(".data/setup/google-oauth.json", JSON.stringify(oauthSettings(a.domain), null, 2) + "\n", { mode: 0o600 });
  console.log(`已创建 ${file}。Google 回调清单：.data/setup/google-oauth.json。下一步见 docs/从零部署.md。`);
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
