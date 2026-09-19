/** Windows 用户级加密配置；凭据只留在 Main，公开快照剔除密码。 */
import { safeStorage, app } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Store } from "../src/core/storage";
import type { DesktopInstance } from "../src/shared/desktop";
import { protectWindows } from "./windows-credentials";
export type Settings = { dataRoot: string; instances: DesktopInstance[]; encryptionKey: string; identity?: { agentId: string; origin: string; token: string }; google?: { clientId: string; clientSecret: string }; maintenance?: string; paired?: boolean };
/** 原子替换密文；解密失败保留原文件，不重置身份。 */
export class SettingsStore {
  private store = new Store(app.getPath("userData"));
  private saving: Promise<void> = Promise.resolve();
  /** 首次安装建立独立数据目录及随机加密密钥。 */
  async read(): Promise<Settings> {
    const encrypted = await this.store.read<string>("settings.json");
    if (!encrypted) return { dataRoot: !app.isPackaged && process.env.LIVENEST_TEST_DATA ? path.join(app.getPath("userData"), "data") : path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "LiveNest"), instances: [], encryptionKey: randomBytes(32).toString("hex") };
    try { return JSON.parse(encrypted.startsWith("dpapi:") ? (await protectWindows(Buffer.from(encrypted.slice(6), "base64"), false)).toString("utf8") : safeStorage.decryptString(Buffer.from(encrypted, "base64"))) as Settings; }
    catch { throw new Error("无法解密本机配置，请使用原 Windows 账户打开；不要删除配置文件。"); }
  }
  /** 仅在系统加密可用时保存，不降级为明文。 */
  async write(settings: Settings) {
    if (process.platform !== "win32") throw new Error("此版本需要 Windows 用户凭据保护。");
    const plaintext = Buffer.from(JSON.stringify(settings), "utf8");
    const next = this.saving.catch(() => {}).then(async () => { const encrypted = await protectWindows(plaintext, true); await this.store.write("settings.json", "dpapi:" + encrypted.toString("base64")); }); this.saving = next; await next;
  }
}
/** 映射核心配置；各实例独立素材目录，不加载旧安装的环境文件。 */
export function environment(settings: Settings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", LIVEPILOT_MODE: "local", LIVEPILOT_ORIGIN: settings.identity?.origin || "https://livenest.duckdns.org", LIVEPILOT_DATA_ROOT: path.join(settings.dataRoot, "state"), LIVEPILOT_ENCRYPTION_KEY: settings.encryptionKey, LIVEPILOT_INSTANCES: settings.instances.map(i => i.id).join(","), GOOGLE_CLIENT_ID: settings.google?.clientId, GOOGLE_CLIENT_SECRET: settings.google?.clientSecret };
  for (const i of settings.instances) {
    const prefix = "LIVEPILOT_INSTANCE_" + i.id.toUpperCase() + "_";
    Object.assign(env, { [prefix + "NAME"]: i.name, [prefix + "OBS_EXE"]: i.exe, [prefix + "OBS_WS_URL"]: "ws://127.0.0.1:" + i.port, [prefix + "OBS_WS_PASSWORD"]: i.password, [prefix + "MEDIA_ROOT"]: path.join(settings.dataRoot, "media", i.id) });
  }
  if (settings.maintenance) env.LIVENEST_MAINTENANCE = settings.maintenance;
  return env;
}
