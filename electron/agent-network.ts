/** 将 Electron 解析的系统代理传给独立 Node Agent；不改系统设置、不输出代理凭据。 */
export type ProxyResolver = (url: string) => Promise<string>;
/** 只接受 Node 支持的 HTTP(S) 代理；按系统返回顺序选择，不能把 SOCKS 静默降为直连。 */
function proxyUrl(value: string): string | undefined {
  const first = value.split(";")[0].trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error("当前系统代理类型不受内置 Agent 支持，请使用 HTTP/HTTPS 代理后重新打开客户端。配对和配置已保留。");
  try {
    const url = new URL((match[1].toUpperCase() === "HTTPS" ? "https://" : "http://") + match[2]);
    if (!url.hostname || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error("系统代理地址无效，请检查系统代理后重新打开客户端。配对和配置已保留。"); }
}
/** 在 spawn 前解析代理：显式环境变量优先；本机 OBS 始终直连，解析失败不猜测网络路径。 */
export async function agentEnvironment(source: NodeJS.ProcessEnv, origin: string, resolveProxy?: ProxyResolver): Promise<NodeJS.ProcessEnv> {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(LIVEPILOT_|GOOGLE_|NODE_OPTIONS|ELECTRON_)/i.test(key)) delete env[key];
  const bypass = [env.no_proxy || env.NO_PROXY, "localhost", "127.0.0.1", "::1", "[::1]"].filter(Boolean).join(",");
  env.NO_PROXY = bypass; env.no_proxy = bypass;
  // Node 的小写变量优先；已有显式 HTTPS 配置保持原样。
  if (!env.https_proxy && !env.HTTPS_PROXY && resolveProxy) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolved: string;
    try {
      resolved = await Promise.race([resolveProxy(origin), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); })]);
    } catch { throw new Error("无法读取系统代理，请检查网络或代理软件后重新打开客户端。配对和配置已保留。"); }
    finally { clearTimeout(timer); }
    const proxy = proxyUrl(resolved);
    if (proxy) { env.HTTPS_PROXY = proxy; env.https_proxy = proxy; }
  }
  return env;
}
