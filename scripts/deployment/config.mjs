/** 部署配置的纯函数与保守文件写入；不执行 shell，不打印 Secret。 */
import { parseEnv } from "node:util";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
/** 只接受可直接放入 Nginx 的标准 ASCII 域名，拒绝 IP、路径与注入字符。 */
export function domainName(value) {
  if (typeof value !== "string" || value.length > 253 || isIP(value) || !value.includes(".") || !value.split(".").every(s => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) throw new Error("请提供小写域名，不含 https://、端口或路径。");
  return value;
}
/** 从固定 HTTPS origin 提取域名；部署只支持默认 443 端口。 */
export function originDomain(origin) {
  let url; try { url = new URL(origin); } catch { throw new Error("LIVEPILOT_ORIGIN 无效。"); }
  if (origin !== `https://${url.hostname}`) throw new Error("部署入口必须是 https://域名，无路径、凭据或端口。");
  return domainName(url.hostname);
}
/** Dotenv 值使用不含换行的引号编码，保留 Windows 路径和密码中的 #/$。 */
export function envText(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value) || (value.includes('"') && value.includes("'"))) throw new Error(`无法安全写入变量 ${key}；请手动配置。`);
    const quote = value.includes('"') ? "'" : '"'; return `${key}=${quote}${value}${quote}`;
  }).join("\n") + "\n";
}
/** 读取 dotenv 文件，不把变量注入管理进程，防止污染命令环境。 */
export async function readEnv(file) { return parseEnv(await readFile(file, "utf8")); }
/** 初始化只能创建，绝不覆盖已有密钥和运行参数。 */
export async function createEnv(file, values) {
  try { await writeFile(file, "# LivePilot 私有配置；不要提交到 Git。\n" + envText(values), { flag: "wx", mode: 0o600 }); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
}
/** 新云端与新电脑各自生成密钥；现有电脑迁移必须传入旧配置。 */
export function cloudValues(domain) { return { LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: `https://${domainName(domain)}`, LIVEPILOT_DATA_ROOT: "/var/lib/livepilot/data", LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex"), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }; }
/** 为新 Agent 或旧本机配置创建独立环境；不复制其他电脑的设备凭据。 */
export function agentValues(domain, id, previous = {}, proxy = "") {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(id || "")) throw new Error("设备 ID 应为小写字母开头的字母、数字或下划线，最多 32 位。");
  if (proxy) { const u = new URL(proxy); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("代理请使用无账号密码的 http(s)://主机:端口。"); }
  return { ...previous, LIVEPILOT_MODE: "local", LIVEPILOT_ORIGIN: `https://${domainName(domain)}`, LIVEPILOT_AGENT_ID: id, LIVEPILOT_DATA_ROOT: previous.LIVEPILOT_DATA_ROOT || ".data", LIVEPILOT_INSTANCES: previous.LIVEPILOT_INSTANCES || "main", LIVEPILOT_ENCRYPTION_KEY: previous.LIVEPILOT_ENCRYPTION_KEY || randomBytes(32).toString("hex"), ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1,::1" } : {}) };
}
/** 生成 Google 控制台可逐项核对的清单，不假装替用户创建 OAuth 客户端。 */
export function oauthSettings(domain) {
  return { authorizedRedirectUri: `https://${domainName(domain)}/api/youtube/callback`, localRedirectUri: "http://127.0.0.1:3010/api/youtube/callback", clientType: "Web application", javascriptOriginsRequired: false, consoleUrl: "https://console.cloud.google.com/auth/clients", steps: ["选择自己的 Google 项目，启用 YouTube Data API v3。", "在 Audience 配置测试用户；测试模式的授权期限需按 Google 当前规则确认。", "编辑匹配 GOOGLE_CLIENT_ID 的 Web application 客户端，追加 authorizedRedirectUri，保留原回调。", "保存后重新打开客户端核对；等待 Google 配置生效。", "在 Agent 填写 Client ID/Secret；云端不保存频道令牌。", "登录云端，选择在线设备及实例，由频道持有人完成同意。"] };
}
