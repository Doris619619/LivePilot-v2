/** 通过 DuckDNS 官方接口更新指定域名；Token 只从私有文件读取且不打印 URL。 */
import { parseArgs } from "node:util";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve4 } from "node:dns/promises";
import { domainName } from "./deployment/config.mjs";
/** 默认仅预览；--apply 显式发布 DNS，禁止自动检测为操作电脑的出口 IP。 */
async function main() {
  const { values: a } = parseArgs({ options: { domain: { type: "string" }, ip: { type: "string" }, "token-file": { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean" } } });
  if (a.help) { console.log("npm run dns:duckdns -- --domain NAME.duckdns.org --ip SERVER_IPV4 --token-file .data/duckdns-token.txt [--apply]"); return; }
  const domain = domainName(a.domain); if (!/^[a-z0-9-]+\.duckdns\.org$/.test(domain) || isIP(a.ip) !== 4) throw new Error("只支持一个 DuckDNS 子域名和显式服务器 IPv4。");
  console.log(`目标 A 记录：${domain} -> ${a.ip}`);
  if (!a.apply) { console.log("预览完成；确认后加 --apply。未发出更新请求。"); return; }
  if (!a["token-file"]) throw new Error("请提供私有 --token-file，勿把 Token 放在命令参数或仓库。");
  const token = (await readFile(a["token-file"], "utf8")).trim(); if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error("Token 文件格式无效。");
  const url = new URL("https://www.duckdns.org/update"); url.search = new URLSearchParams({ domains: domain.split(".")[0], token, ip: a.ip }).toString();
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || (await response.text()).trim() !== "OK") throw new Error("DNS 更新未成功，请在 DuckDNS 控制台检查。");
  console.log("DuckDNS 已接受更新。");
  try { console.log((await resolve4(domain)).includes(a.ip) ? "本地 DNS 已解析到目标 IP。" : "DNS 缓存尚未更新；稍后运行 doctor。"); } catch { console.log("DNS 暂未解析；稍后运行 doctor。"); }
}
void main().catch(() => { console.error("DuckDNS 更新失败或参数不完整。检查 --help、Token 文件和网络；日志不输出凭据。"); process.exitCode = 1; });
