/** 更新通知保留已知版本；下载和安装始终需要显式动作及维护许可。 */
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ handlers: new Map<string, (value?: unknown) => void>(), answer: vi.fn(), download: vi.fn(), install: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false }, dialog: { showMessageBox: mock.answer } }));
vi.mock("electron-updater", () => ({ autoUpdater: { on: (event: string, handler: (value?: unknown) => void) => mock.handlers.set(event, handler), downloadUpdate: mock.download, quitAndInstall: mock.install, autoDownload: true, autoInstallOnAppQuit: true } }));
import { Updates } from "../electron/updates";
import { autoUpdater } from "electron-updater";
beforeEach(() => { mock.handlers.clear(); vi.clearAllMocks(); });
/** 通知不自动下载，失败后入口仍能显示已知版本。 */
it("retains discovered version for retry without automatic download or installation", async () => {
  const updates = new Updates();
  expect(autoUpdater.autoDownload).toBe(false); expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  mock.handlers.get("update-available")!({ version: "0.1.1" });
  expect(mock.download).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled();
  mock.download.mockRejectedValueOnce(new Error("synthetic network failure")); await updates.download();
  expect(updates.state.status).toBe("error"); expect(updates.state.version).toBe("0.1.1");
  mock.handlers.get("error")!(); expect(updates.state.version).toBe("0.1.1");
});
/** 取消和维护拒绝都不会退出或安装，只有用户确认且维护完成后执行。 */
it("requires confirmation and maintenance permission before restarting", async () => {
  const updates = new Updates(); mock.handlers.get("update-downloaded")!({ version: "0.1.1" });
  const prepare = vi.fn(); const quit = vi.fn();
  expect(mock.install).not.toHaveBeenCalled();
  mock.answer.mockResolvedValueOnce({ response: 0 }); await updates.install(prepare, quit);
  expect(prepare).not.toHaveBeenCalled();
  mock.answer.mockResolvedValue({ response: 1 }); prepare.mockRejectedValueOnce(new Error("直播状态未知"));
  await expect(updates.install(prepare, quit)).rejects.toThrow("直播状态未知");
  expect(quit).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled(); expect(updates.state.status).toBe("downloaded");
  prepare.mockResolvedValueOnce(undefined); await updates.install(prepare, quit);
  expect(quit).toHaveBeenCalledOnce(); expect(mock.install).toHaveBeenCalledWith(false, true);
});
