/** 只读部署诊断：检查配置、DNS、TLS、设备身份和 OBS 本机路径；不触发广播。 */
import { parseArgs } from "node:util";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { resolve4, resolve6 } from "node:dns/promises";
import { readEnv, originDomain, oauthSettings } from "./deployment/config.mjs";
/** 将失败归纳为可行动项；日志不输出环境对象、令牌或带敏感 query 的 URL。 */
async function main() {
  const { values: a } = parseArgs({ options: { env: { type: "string", default: ".env.agent" }, ip: { type: "string" }, offline: { type: "boolean" } } });
  const env = await readEnv(a.env); const domain = originDomain(env.LIVEPILOT_ORIGIN); let failures = 0;
  /** 单项失败继续其他检查，最后以非零状态告诉自动化未就绪。 */
  async function check(label, fn) { try { await fn(); console.log(`OK ${label}`); } catch { failures++; console.log(`FAIL ${label}`); } }
  await check("加密密钥格式", async () => { if (!/^[a-f0-9]{64}$/i.test(env.LIVEPILOT_ENCRYPTION_KEY || "")) throw Error(); });
  await check("运行模式为 local 或 cloud", async () => { if (!["local", "cloud"].includes(env.LIVEPILOT_MODE)) throw Error(); });
  if (env.LIVEPILOT_MODE !== "cloud") {
    const ids = (env.LIVEPILOT_INSTANCES || "main").split(",").map(s => s.trim());
    await check("实例 ID 不重复且包含 main", async () => { if (!ids.includes("main") || new Set(ids).size !== ids.length || ids.some(id => !/^[a-z][a-z0-9_]{0,31}$/.test(id))) throw Error(); });
    for (const id of ids) {
      const prefix = `LIVEPILOT_INSTANCE_${id.toUpperCase()}_`;
      const value = suffix => env[prefix + suffix] || (id === "main" ? env["LIVEPILOT_" + suffix] : "");
      await check(`${id} OBS 程序存在`, () => access(value("OBS_EXE") || "__missing_obs__"));
      await check(`${id} 媒体目录存在`, () => access(env[prefix + "MEDIA_ROOT"] || env.LIVEPILOT_MEDIA_ROOT || "__missing_media__"));
      await check(`${id} WebSocket 为本机地址且设置密码`, async () => { const u = new URL(value("OBS_WS_URL")); if (u.protocol !== "ws:" || u.hostname !== "127.0.0.1" || !u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash || !value("OBS_WS_PASSWORD")) throw Error(); });
    }
    await check("Google Client ID / Secret 已填写", async () => { if (!env.GOOGLE_CLIENT_ID?.endsWith(".apps.googleusercontent.com") || !env.GOOGLE_CLIENT_SECRET) throw Error(); });
    await check("已配对且域名/设备身份一致", async () => { const id = JSON.parse(await readFile(path.join(path.resolve(env.LIVEPILOT_DATA_ROOT || ".data"), "agent/identity.json"), "utf8")); if (id.origin !== env.LIVEPILOT_ORIGIN || id.agentId !== env.LIVEPILOT_AGENT_ID) throw Error(); });
  }
  if (!a.offline) {
    await check("DNS A 记录" + (a.ip ? "匹配服务器 IP" : "存在"), async () => { const ips = await resolve4(domain); if (!ips.length || a.ip && !ips.includes(a.ip)) throw Error(); });
    try { const ipv6 = await resolve6(domain); if (ipv6.length) console.log("提示：存在 AAAA 记录，请确认 IPv6 同样指向此服务器且能访问 80/443。"); } catch { /* 没有 IPv6 记录是受支持的部署。 */ }
    await check("HTTPS 证书与 /api/health", async () => { const r = await fetch(`${env.LIVEPILOT_ORIGIN}/api/health`, { redirect: "error", signal: AbortSignal.timeout(15000) }); if (!r.ok || (await r.json()).ok !== true) throw Error(); });
  }
  console.log(`Google 控制台必须核对：${oauthSettings(domain).authorizedRedirectUri}`);
  console.log("以上检查不证明 Google 回调已登记、Agent 心跳在线或真实直播成功；请按文档完成登录、设备与实播验收。");
  process.exitCode = failures ? 1 : 0;
}
void main().catch(() => { console.error("诊断失败：检查 --env 文件、权限及域名格式。"); process.exitCode = 1; });
