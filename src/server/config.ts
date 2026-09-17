/** 服务端环境配置：兼容原实例配置，校验公网入口及直播电脑上的 OBS。 */
import "server-only";
import path from "node:path";
import { AppError } from "./errors";

/** 解析稳定实例 ID；ID 同时用于路由与存储目录，因此禁止路径字符。 */
export function instanceIds(): string[] {
  const ids = (process.env.LIVEPILOT_INSTANCES || "main").split(",").map(id => id.trim());
  if (!ids.includes("main") || ids.some(id => !/^[a-z][a-z0-9_]{0,31}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new AppError("CONFIG", "LIVEPILOT_INSTANCES 必须包含 main，且使用不重复的小写字母、数字、下划线 ID。");
  }
  return ids;
}

/** 拒绝未知实例；任何写操作必须显式指定一个已配置的 ID。 */
export function requireInstance(id: unknown): string {
  if (typeof id !== "string" || !instanceIds().includes(id)) throw new AppError("INSTANCE", "实例不存在，请刷新页面检查 LIVEPILOT_INSTANCES。", 400);
  return id;
}

/** 返回实例变量前缀，不包含任何配置值。 */
export function instancePrefix(id: string) { return "LIVEPILOT_INSTANCE_" + id.toUpperCase() + "_"; }

/** 读取指定实例配置；main 保留旧路径、授权及环境变量。Secret 仅供服务端使用。 */
export function config(id = "main") {
  requireInstance(id);
  const prefix = instancePrefix(id);
  /** main 兼容旧变量；其他实例绝不继承 main 的 OBS 密码或路径。 */
  const obsValue = (suffix: string, legacy: string, fallback = "") => process.env[prefix + suffix] ?? (id === "main" ? process.env[legacy] : undefined) ?? fallback;
  const origin = process.env.LIVEPILOT_ORIGIN || "http://127.0.0.1:3010";
  let publicUrl: URL;
  try { publicUrl = new URL(origin); } catch { throw new AppError("CONFIG", "LIVEPILOT_ORIGIN 地址无效。"); }
  if (publicUrl.origin !== origin || publicUrl.username || publicUrl.password || (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && publicUrl.hostname === "127.0.0.1" && publicUrl.port))) throw new AppError("CONFIG", "公网地址必须使用 HTTPS；仅本机 127.0.0.1 允许 HTTP。");
  const wsUrl = obsValue("OBS_WS_URL", "LIVEPILOT_OBS_WS_URL", id === "main" ? "ws://127.0.0.1:4455" : "");
  let ws: URL | undefined;
  try { ws = wsUrl ? new URL(wsUrl) : undefined; } catch { throw new AppError("CONFIG", id + " 的 OBS WebSocket 地址格式无效。"); }
  if (ws && (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" || !ws.port || ws.username || ws.password || ws.pathname !== "/" || ws.search || ws.hash)) throw new AppError("CONFIG", id + " 的 OBS WebSocket 必须使用 ws://127.0.0.1:端口。");
  const privacy = process.env.LIVEPILOT_PRIVACY || "unlisted";
  if (!["private", "unlisted", "public"].includes(privacy)) throw new AppError("CONFIG", "LIVEPILOT_PRIVACY 必须是 private、unlisted 或 public。");
  const kids = process.env.LIVEPILOT_MADE_FOR_KIDS || "false";
  if (!["true", "false"].includes(kids)) throw new AppError("CONFIG", "LIVEPILOT_MADE_FOR_KIDS 必须是 true 或 false。");
  return {
    origin, wsUrl, wsPort: ws ? Number(ws.port) : 0,
    obsExe: obsValue("OBS_EXE", "LIVEPILOT_OBS_EXE"),
    obsPassword: obsValue("OBS_WS_PASSWORD", "LIVEPILOT_OBS_WS_PASSWORD"),
    mediaRoot: process.env[prefix + "MEDIA_ROOT"] || process.env.LIVEPILOT_MEDIA_ROOT || "",
    clientId: process.env.GOOGLE_CLIENT_ID || "", clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    encryptionKey: process.env.LIVEPILOT_ENCRYPTION_KEY || "",
    dataDir: id === "main" ? dataRoot() : path.join(dataRoot(), "instances", id),
    redirectUri: origin + "/api/youtube/callback", privacy, madeForKids: kids === "true",
  };
}

/** 列出缺少的变量名；不把路径、密码或客户端密钥发送到浏览器。 */
export function missingConfig(id = "main") {
  const c = config(id);
  const prefix = id === "main" ? "LIVEPILOT_" : instancePrefix(id);
  return Object.entries({
    [prefix + "OBS_EXE"]: c.obsExe, [prefix + "OBS_WS_URL"]: c.wsUrl,
    [prefix + "OBS_WS_PASSWORD"]: c.obsPassword,
    LIVEPILOT_MEDIA_ROOT: c.mediaRoot, GOOGLE_CLIENT_ID: c.clientId,
    GOOGLE_CLIENT_SECRET: c.clientSecret, LIVEPILOT_ENCRYPTION_KEY: c.encryptionKey,
  }).filter(([, value]) => !value).map(([key]) => key);
}

/** 检查重复端口及 Windows 路径，防止两个面板控制同一个进程。空配置只阻塞所属实例。 */
export function validateInstances() {
  const ports = new Set<number>(); const paths = new Set<string>();
  for (const id of instanceIds()) {
    const c = config(id);
    const exe = c.obsExe ? path.win32.resolve(c.obsExe).toLowerCase() : "";
    if ((c.wsPort && ports.has(c.wsPort)) || (exe && paths.has(exe))) throw new AppError("CONFIG", "多个实例使用了同一 OBS 路径或 WebSocket 端口。请为每个 Portable OBS 配置独立目录和端口。");
    if (c.wsPort) ports.add(c.wsPort);
    if (exe) paths.add(exe);
  }
}

/** 浏览器只能获取公开的实例 ID 与显示名称。 */
export function instanceDescriptors() {
  validateInstances();
  return instanceIds().map(id => ({ id, name: process.env[instancePrefix(id) + "NAME"] || (id === "main" ? "主 OBS" : id) }));
}

/** 运行数据由宿主机持有，不进入构建追踪；默认完整保留旧 .data。 */
export function dataRoot() { return path.resolve(/* turbopackIgnore: true */ process.env.LIVEPILOT_DATA_ROOT || ".data"); }
