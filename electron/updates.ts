/** 手动下载与本机安全重启；云端登录和配对不参与更新授权。 */
import { app, autoUpdater as lifecycle } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeProblem } from "../src/shared/problems";
import { AppError, problemFor } from "../src/core/errors";
import type { DesktopState } from "../src/shared/desktop";
export class Updates {
  state: DesktopState["update"] = { status: "idle", message: "尚未检查更新" };
  private lastCheck = 0; private checking = false; private installing = false;
  private rejectInstall?: (error: unknown) => void;
  readonly installed = app.isPackaged && existsSync(path.join(process.resourcesPath, "livenest-installed"));
  /** 自动检查不下载、不弹窗；错误按阶段保留准确的重试入口。 */
  constructor() {
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; autoUpdater.logger = null;
    autoUpdater.on("update-available", info => { if (!this.installing) this.state = { status: "available", version: info.version, message: "发现新版本 " + info.version }; });
    autoUpdater.on("update-not-available", () => { if (!this.installing) this.state = { status: "idle", message: "已是最新版本" }; });
    autoUpdater.on("download-progress", p => { if (!this.installing) this.state = { ...this.state, status: "downloading", percent: p.percent, message: "正在下载" }; });
    autoUpdater.on("update-downloaded", info => { if (!this.installing) this.state = { status: "downloaded", version: info.version, message: "下载完成，可以重启更新" }; });
    autoUpdater.on("error", error => { this.fail(error); this.rejectInstall?.(new AppError(this.state.problem!.code, this.state.message!, 400, this.state.problem)); });
  }
  /** 更新器错误不读取原始 URL/路径；安装失败不能归类为网络检查失败。 */
  private fail(error: unknown) {
    const code = (error as { code?: string } | undefined)?.code;
    const integrity = ["ERR_UPDATER_INVALID_SIGNATURE", "ERR_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_UPDATE_INFO", "ERR_UPDATER_NO_FILES_PROVIDED"].includes(code || "");
    const disk = ["ENOSPC", "EACCES", "EPERM"].includes(code || "");
    const install = this.state.stage === "install";
    const stage = install ? "启动安装程序" : this.state.stage === "download" ? "下载更新" : "检查更新";
    const problem = disk ? problemFor(error, { domain: "update", stage }) : makeProblem(integrity ? "UPDATE_INTEGRITY" : install ? "UPDATE_INSTALL" : "UPDATE_NETWORK", integrity ? "更新文件校验或发行信息异常，未安装。请联系管理员核对官方发行文件。" : install ? "安装程序未能启动。请重试重启更新；仍失败时从官方下载页手动安装，保留原数据目录。" : "更新未完成，当前版本仍可使用。请检查网络后重试。", { domain: "update", stage, outcome: "rejected" });
    this.state = { ...this.state, status: "error", problem, message: problem.message };
  }
  /** 焦点补查不会覆盖下载、安装准备或等待重试的安装结果。 */
  async check(automatic = false) {
    if (!this.installed) { this.state = { status: "preview", message: "目录预览版不支持更新，请使用安装版。" }; return; }
    if (this.checking || this.installing || ["available", "downloading", "downloaded", "installing"].includes(this.state.status) || (this.state.status === "error" && this.state.stage === "install") || (automatic && Date.now() - this.lastCheck < 3_600_000)) return;
    this.checking = true; this.lastCheck = Date.now(); this.state = { ...this.state, status: "checking", stage: "check", automatic, problem: undefined, message: "正在检查更新…" };
    try { await autoUpdater.checkForUpdates(); } catch (e) { this.fail(e); } finally { this.checking = false; }
    if (this.state.status === "error") throw new AppError(this.state.problem!.code, this.state.message!, 400, this.state.problem);
  }
  /** 用户发起下载；失败返回明确错误，不将失败操作记为完成。 */
  async download() {
    if (this.state.status !== "available" && !(this.state.status === "error" && this.state.stage === "download" && this.state.problem?.code !== "UPDATE_INTEGRITY")) throw new AppError("UPDATE_STATE", "当前没有可下载的更新，请先检查更新状态。");
    this.state = { ...this.state, status: "downloading", stage: "download", automatic: false, problem: undefined, percent: 0, message: "正在下载" };
    try { await autoUpdater.downloadUpdate(); } catch (e) { this.fail(e); }
    if (this.state.status === "error") throw new AppError(this.state.problem!.code, this.state.message!, 400, this.state.problem);
  }
  /** 只有更新器确认进入退出生命周期才放行退出；拒绝或超时保留客户端。 */
  private handoff(quit: () => void) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); lifecycle.off("before-quit-for-update", accepted); this.rejectInstall = undefined; };
      const failed = (error: unknown) => { cleanup(); reject(error); };
      const accepted = () => { cleanup(); quit(); resolve(); };
      const timer = setTimeout(() => failed(new AppError("UPDATE_INSTALL", "安装程序未确认启动。客户端已保留，请重试重启更新；仍失败时从官方下载页手动安装。")), 10_000);
      this.rejectInstall = failed; lifecycle.once("before-quit-for-update", accepted);
      try { autoUpdater.quitAndInstall(true, true); } catch (error) { this.fail(error); failed(new AppError(this.state.problem!.code, this.state.message!, 400, this.state.problem)); }
    });
  }
  /** 点击明确的更新按钮即授权安装；检查、排空与静默重启串行执行，不重复弹窗。 */
  async install(prepare: () => Promise<void>, quit: () => void) {
    if (this.installing) throw new AppError("UPDATE_STATE", "更新仍在处理，请等待当前操作完成。");
    if (this.state.status !== "downloaded" && !(this.state.status === "error" && this.state.stage === "install" && this.state.problem?.code !== "UPDATE_INTEGRITY")) throw new AppError("UPDATE_STATE", "更新尚未下载完成，请先检查更新状态。");
    this.installing = true;
    try {
      this.state = { ...this.state, status: "preparing", stage: "install", automatic: false, problem: undefined, message: "正在核对 OBS 状态并等待 Agent 任务完成…" };
      await prepare();
      this.state = { ...this.state, status: "installing", message: "正在启动安装程序…" };
      await this.handoff(quit); return true;
    } catch (error) {
      const original = problemFor(error, { domain: "update", stage: this.state.status === "installing" ? "启动安装程序" : "准备安装更新", outcome: "not-sent" });
      const problem = { ...original, message: "更新尚未开始安装。" + original.message };
      this.state = { ...this.state, status: "error", stage: "install", automatic: false, problem, message: problem.message };
      throw new AppError(problem.code, problem.message, 400, problem);
    } finally { this.installing = false; }
  }
}
