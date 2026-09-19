/** Threadline 同款手动下载、确认重启更新；安装前由宿主取得直播维护锁。 */
import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DesktopState } from "../src/shared/desktop";
export class Updates {
  state: DesktopState["update"] = { status: "idle", message: "尚未检查更新" }; private lastCheck = 0; private checking = false;
  readonly installed = app.isPackaged && existsSync(path.join(process.resourcesPath, "livenest-installed"));
  /** 自动检查不自动下载、弹窗或重启；原始下载错误不写日志。 */
  constructor() {
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; autoUpdater.logger = null;
    autoUpdater.on("update-available", info => { this.state = { status: "available", version: info.version, message: "发现新版本 " + info.version }; });
    autoUpdater.on("update-not-available", () => { this.state = { status: "idle", message: "已是最新版本" }; });
    autoUpdater.on("download-progress", p => { this.state = { ...this.state, status: "downloading", percent: p.percent, message: "正在下载" }; });
    autoUpdater.on("update-downloaded", info => { this.state = { status: "downloaded", version: info.version, message: "下载完成，可以重启更新" }; });
    autoUpdater.on("error", () => { this.state = { ...this.state, status: "error", message: "更新请求失败，当前版本仍可使用。" }; });
  }
  /** 焦点和唤醒补查最少间隔一小时，已发现版本不会被覆盖。 */
  async check(automatic = false) {
    if (!this.installed) { this.state = { status: "preview", message: "目录预览版不支持更新，请使用安装版。" }; return; }
    if (this.checking || ["available", "downloading", "downloaded", "installing"].includes(this.state.status) || (automatic && Date.now() - this.lastCheck < 3_600_000)) return;
    this.checking = true; this.lastCheck = Date.now(); this.state = { ...this.state, status: "checking", message: "正在检查更新…" };
    try { await autoUpdater.checkForUpdates(); } catch { this.state = { ...this.state, status: "error", message: "无法读取更新源，请检查网络后重试。" }; } finally { this.checking = false; }
  }
  /** 用户点击才下载，普通退出仍不安装。 */
  async download() { if (this.state.status !== "available") return; this.state = { ...this.state, status: "downloading", percent: 0 }; try { await autoUpdater.downloadUpdate(); } catch { this.state = { ...this.state, status: "error", message: "下载未完成，请重新检查更新。" }; } }
  /** 用户确认后先申请维护及排空任务，再调用更新器标准退出生命周期。 */
  async install(prepare: () => Promise<void>, quit: () => void) {
    if (this.state.status !== "downloaded") return;
    const answer = await dialog.showMessageBox({ type: "question", title: "重启更新", message: "确认结束当前配置并重启 LiveNest？", buttons: ["稍后", "重启更新"], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return;
    await prepare(); this.state = { ...this.state, status: "installing", message: "正在安装更新" }; quit(); autoUpdater.quitAndInstall(false, true);
  }
}
