/** 更新状态机回归：本机准备、重复点击、安装交接失败和阶段重试。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ handlers: new Map<string, (value?: unknown) => void>(), lifecycle: new Map<string, () => void>(), answer: vi.fn(), download: vi.fn(), install: vi.fn(), check: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false }, autoUpdater: { once: (event: string, handler: () => void) => mock.lifecycle.set(event, handler), off: (event: string) => mock.lifecycle.delete(event) }, dialog: { showMessageBox: mock.answer } }));
vi.mock("electron-updater", () => ({ autoUpdater: { on: (event: string, handler: (value?: unknown) => void) => mock.handlers.set(event, handler), checkForUpdates: mock.check, downloadUpdate: mock.download, quitAndInstall: mock.install, autoDownload: true, autoInstallOnAppQuit: true } }));
import { Updates } from "../electron/updates";
import { AppError } from "../src/core/errors";
import { autoUpdater } from "electron-updater";
beforeEach(() => { mock.handlers.clear(); mock.lifecycle.clear(); vi.resetAllMocks(); mock.install.mockImplementation(() => mock.lifecycle.get("before-quit-for-update")?.()); });
afterEach(() => vi.useRealTimers());
/** 合成已校验下载，避免接触真实 updater 缓存。 */
function downloaded() { const updates = new Updates(); Object.defineProperty(updates, "installed", { value: true }); mock.handlers.get("update-downloaded")!({ version: "0.1.4" }); return updates; }
it("retains version on download failure without automatic download or install", async () => {
  const updates = new Updates(); expect(autoUpdater.autoDownload).toBe(false); expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  mock.handlers.get("update-available")!({ version: "0.1.4" }); expect(mock.download).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled();
  mock.download.mockRejectedValueOnce(new Error("private URL")); await expect(updates.download()).rejects.toMatchObject({ code: "UPDATE_NETWORK" });
  expect(updates.state).toMatchObject({ status: "error", version: "0.1.4", stage: "download" });
});
it("cancel preserves download; preparation failure becomes a retryable install error", async () => {
  const updates = downloaded(); const prepare = vi.fn(); const quit = vi.fn();
  mock.answer.mockResolvedValueOnce({ response: 0 }); expect(await updates.install(prepare, quit)).toBe(false); expect(prepare).not.toHaveBeenCalled();
  mock.answer.mockResolvedValue({ response: 1 }); prepare.mockRejectedValueOnce(new AppError("OBS_MAINTENANCE", "OBS 2 正在录制，请在完成后重试。"));
  await expect(updates.install(prepare, quit)).rejects.toMatchObject({ code: "OBS_MAINTENANCE" });
  expect(quit).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled(); expect(updates.state).toMatchObject({ status: "error", stage: "install", version: "0.1.4" });
  expect(updates.state.message).toContain("OBS 2"); expect(updates.state.message).not.toContain("下载完成");
  await updates.check(true); expect(mock.check).not.toHaveBeenCalled(); expect(updates.state.status).toBe("error");
  await updates.install(prepare, quit); expect(quit).toHaveBeenCalledOnce(); expect(mock.install).toHaveBeenCalledWith(false, true);
});
it("shows preparing, rejects duplicate clicks, ignores late download notifications", async () => {
  const updates = downloaded(); mock.answer.mockResolvedValue({ response: 1 });
  let done!: () => void; const wait = new Promise<void>(resolve => { done = resolve; });
  const first = updates.install(() => wait, vi.fn()); await Promise.resolve(); expect(updates.state.status).toBe("preparing");
  await expect(updates.install(vi.fn(), vi.fn())).rejects.toMatchObject({ code: "UPDATE_STATE" }); expect(mock.answer).toHaveBeenCalledOnce();
  mock.handlers.get("update-downloaded")!({ version: "stale" }); expect(updates.state.version).toBe("0.1.4"); expect(updates.state.status).toBe("preparing");
  done(); await first;
});
it.each(["throw", "error-event", "timeout"])("keeps quit blocked on installer %s and supports retry", async mode => {
  vi.useFakeTimers(); const updates = downloaded(); mock.answer.mockResolvedValue({ response: 1 }); const quit = vi.fn();
  mock.install.mockImplementationOnce(() => { if (mode === "throw") throw new Error("private installer path"); if (mode === "error-event") mock.handlers.get("error")!(new Error("private URL")); });
  const result = expect(updates.install(vi.fn(), quit)).rejects.toMatchObject({ code: "UPDATE_INSTALL" });
  await vi.advanceTimersByTimeAsync(10_001); await result;
  expect(quit).not.toHaveBeenCalled(); expect(updates.state).toMatchObject({ status: "error", stage: "install" }); expect(updates.state.message).not.toMatch(/private|检查网络/); expect(mock.lifecycle.size).toBe(0);
  await updates.install(vi.fn(), quit); expect(quit).toHaveBeenCalledOnce();
});
it.each([["ERR_CHECKSUM_MISMATCH", "UPDATE_INTEGRITY"], ["ENOSPC", "STORAGE_SPACE"], ["ECONNRESET", "UPDATE_NETWORK"]])("classifies %s without leaking paths", async (code, expected) => {
  const updates = new Updates(); mock.handlers.get("update-available")!({ version: "0.1.4" }); mock.download.mockRejectedValueOnce(Object.assign(new Error("private signed URL"), { code }));
  await expect(updates.download()).rejects.toMatchObject({ code: expected }); expect(updates.state.message).not.toContain("private");
  if (expected === "UPDATE_INTEGRITY") { await expect(updates.download()).rejects.toMatchObject({ code: "UPDATE_STATE" }); expect(mock.download).toHaveBeenCalledOnce(); }
});
