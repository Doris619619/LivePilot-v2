/** Windows 用户级加密配置；凭据只留在 Main，公开快照剔除密码。 */
import { AppError } from "../src/core/errors";
import { safeStorage, app } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Store } from "../src/core/storage";
import type { DesktopInstance } from "../src/shared/desktop";
import { claimRoot, claimLegacyRoot, readRoot, checkRootPath, ordinaryPath } from "./data-root";
import { access } from "node:fs/promises";
import { protectWindows } from "./windows-credentials";
export type Settings = { firewallAttempt?: string; dataNotice?: string; rootId?: string; dataRoot: string; instances: DesktopInstance[]; candidates?: DesktopInstance[]; archivedCandidates?: DesktopInstance[]; encryptionKey: string; identity?: { agentId: string; origin: string; token: string }; google?: { clientId: string; clientSecret: string }; maintenance?: string; inventoryPending?: boolean; paired?: boolean };
/** AppData 只保存位置；身份与业务配置由目标目录中的 DPAPI 密文持有。 */
export class SettingsStore {
  private locator = new Store(app.getPath("userData"));
  private saving: Promise<void> = Promise.resolve();
  /** Agent 排空后等待最后一次配置落盘；写入失败必须阻止安装。 */
  async flush() { await this.saving; }
  /** 开发测试使用独立目录；生产绝不接受环境变量覆盖。 */
  private installation() { return app.isPackaged ? path.dirname(app.getPath("exe")) : undefined; }
  /** 无配置不代表可以重置损坏身份；只在明确的新空根下生成初始状态。 */
  private fresh(dataRoot = ""): Settings { return { dataRoot, instances: [], encryptionKey: randomBytes(32).toString("hex") }; }
  /** 解密且验证最小配置，错误不透传凭据。 */
  private async decode(encrypted: string): Promise<Settings> {
    try {
      const value = JSON.parse(encrypted.startsWith("dpapi:") ? (await protectWindows(Buffer.from(encrypted.slice(6), "base64"), false)).toString("utf8") : safeStorage.decryptString(Buffer.from(encrypted, "base64"))) as Settings;
      if (!value.dataRoot || !Array.isArray(value.instances) || !/^[a-f0-9]{64}$/.test(value.encryptionKey)) throw new Error();
      return value;
    } catch { throw new AppError("DATA", "无法解密本机配置，请使用原 Windows 账户打开；不要删除配置文件。"); }
  }
  /** 只有文件真正不存在才返回空；null、空串和 false 均不能触发新身份初始化。 */
  private async record<T>(store: Store, name: string): Promise<T | null> {
    const value = await store.read<T>(name);
    if (!value) {
      const exists = await access(path.join(store.dir, name)).then(() => true, error => { if(error.code === "ENOENT") return false; throw error; });
      if (exists) throw new AppError("DATA", "本机配置内容为空或损坏，请保留原文件并恢复配置；没有创建新身份。");
    }
    return value;
  }
  /** 定位记录优先；目标丢失禁止退回旧副本并产生分叉身份。 */
  async read(): Promise<Settings> {
    const location = await this.record<{ version: number; dataRoot: string; rootId?: string; pending?: boolean }>(this.locator, "data-location.json");
    if (location) {
      if (location.version !== 1 || !path.isAbsolute(location.dataRoot || "") || (!location.pending && !location.rootId)) throw new AppError("DATA", "数据位置记录损坏，请保留配置并恢复原数据位置。");
      if (location.pending) return this.select(location.dataRoot);
      await access(location.dataRoot).catch(() => { throw new AppError("DATA", "LiveNest 数据盘不可用，请连接原数据盘后重新打开；没有创建新身份。"); });
      await checkRootPath(location.dataRoot, this.installation());
      const marker = await readRoot(location.dataRoot);
      if (marker.id !== location.rootId) throw new AppError("DATA", "LiveNest 数据目录归属已改变，未加载或覆盖配置。");
      const store = await this.rootStore(location.dataRoot);
      const encrypted = await this.record<string>(store, "settings.json");
      if (!encrypted) throw new AppError("DATA", "LiveNest 数据配置缺失，请恢复原配置；没有创建新身份。");
      const settings = await this.decode(encrypted);
      if (settings.rootId !== marker.id || (await ordinaryPath(settings.dataRoot)).toLowerCase() !== (await ordinaryPath(location.dataRoot)).toLowerCase()) throw new AppError("DATA", "LiveNest 配置与数据位置不匹配，请恢复原目录。");
      return settings;
    }
    const legacy = await this.record<string>(this.locator, "settings.json");
    if (legacy) {
      const settings = await this.decode(legacy);
      const marker = await claimLegacyRoot(settings, this.installation());
      // 定位记录提交中断时，根内已验证的配置比保留的旧密文更新；不可用旧快照覆盖。
      const existing = await this.record<string>(await this.rootStore(settings.dataRoot), "settings.json");
      if(existing) return this.select(settings.dataRoot);
      const next = { ...settings, rootId: marker.id };
      await this.write(next); return next;
    }
    if (!app.isPackaged && process.env.LIVENEST_TEST_DATA) return this.select(path.join(app.getPath("userData"), "data"));
    return this.fresh();
  }
  /** 选择现有根先解密；只有标记或空骨架的根允许新建，避免覆盖残存身份。 */
  async select(target: string): Promise<Settings> {
    const marker = await claimRoot(target, this.installation());
    const store = await this.rootStore(target);
    const encrypted = await this.record<string>(store, "settings.json");
    if (encrypted) {
      const settings = await this.decode(encrypted);
      if (settings.rootId !== marker.id || (await ordinaryPath(settings.dataRoot)).toLowerCase() !== (await ordinaryPath(target)).toLowerCase()) throw new AppError("DATA", "已有 LiveNest 配置与选择位置不匹配，没有覆盖文件。");
      // 存活 Agent 的目录不能被第二个安装接管；失效锁由原有恢复机制处理。
      const lock = await import("node:fs/promises").then(fs => fs.readFile(path.join(target, "state", "host.lock"), "utf8")).catch(e => { if (e.code === "ENOENT") return ""; throw e; });
      if (lock) { const pid = Number(lock); if (!Number.isInteger(pid) || pid <= 0) throw new AppError("DATA", "已有 Agent 锁损坏，请保留原目录。"); try { process.kill(pid, 0); throw new AppError("DATA", "原数据目录仍有 Agent 使用，请先退出原客户端。"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
      await this.write(settings); return settings;
    }
    const settings = { ...this.fresh(target), rootId: marker.id };
    const { hasData } = await import("./data-root");
    if (await hasData(settings)) throw new AppError("DATA", "数据目录已有业务文件但缺少桌面配置，未创建新身份。");
    await this.write(settings); return settings;
  }
  /** 校验 state 和 desktop 路径后使用现有原子存储。 */
  private async rootStore(root: string) { const dir = path.join(root, "state", "desktop"); await ordinaryPath(dir); return new Store(dir); }
  /** 先保存并读回密文，再提交定位记录；调用方只能在成功后替换内存配置。 */
  async write(settings: Settings) {
    if (!settings.dataRoot) return;
    const snapshot = structuredClone(settings);
    const next = this.saving.catch(() => {}).then(async () => {
      const marker = await readRoot(snapshot.dataRoot);
      if (snapshot.rootId !== marker.id) throw new AppError("DATA", "LiveNest 数据根目录归属不匹配，未保存配置。");
      const store = await this.rootStore(snapshot.dataRoot);
      const encrypted = await protectWindows(Buffer.from(JSON.stringify(snapshot), "utf8"), true);
      await store.write("settings.json", "dpapi:" + encrypted.toString("base64"));
      const verified = await this.decode((await store.read<string>("settings.json"))!);
      if (JSON.stringify(verified) !== JSON.stringify(snapshot)) throw new AppError("DATA", "本机配置写入校验失败，原数据位置保留。");
      await this.locator.write("data-location.json", { version: 1, dataRoot: snapshot.dataRoot, rootId: marker.id });
    }); this.saving = next; await next;
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
