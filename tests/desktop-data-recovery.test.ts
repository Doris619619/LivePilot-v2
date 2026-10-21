/** 启动恢复交互回归；界面为合成原生对话框，禁止创建新身份或启动 OBS。 */
import { expect, it, vi } from "vitest";
import { initializeWithRecovery, type RecoveryInterface } from "../electron/data-recovery";
import type { SettingsStore } from "../electron/settings";
/** 每例仅提供恢复依赖，实际读取/定位由独立 SettingsStore 测试覆盖。 */
function fixture() {
  const store = { recoveryLocation: vi.fn().mockResolvedValue("fixture-data"), inspectRecovery: vi.fn().mockResolvedValue({ dataRoot: "verified-original" }), restoreLocation: vi.fn().mockResolvedValue(undefined) };
  const ui = { choose: vi.fn(), locate: vi.fn().mockResolvedValue("selected"), confirm: vi.fn().mockResolvedValue(true), copy: vi.fn() };
  return { store, ui, run: (init: () => Promise<void>) => initializeWithRecovery(init, store as unknown as SettingsStore, ui as RecoveryInterface) };
}
it("stays in recovery after a load failure and allows copying diagnostics before retry", async () => {
  const f = fixture(); const init = vi.fn().mockRejectedValueOnce(new Error("fixture")).mockResolvedValue(undefined);
  f.ui.choose.mockResolvedValueOnce("copy").mockResolvedValueOnce("retry");
  expect(await f.run(init)).toBe(true); expect(init).toHaveBeenCalledTimes(2); expect(f.ui.copy).toHaveBeenCalledOnce(); expect(f.store.restoreLocation).not.toHaveBeenCalled();
});
it("requires validation and explicit confirmation before relocating the original data", async () => {
  const f = fixture(); const init = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue(undefined); f.ui.choose.mockResolvedValue("locate");
  expect(await f.run(init)).toBe(true); expect(f.store.inspectRecovery).toHaveBeenCalledWith("selected"); expect(f.ui.confirm).toHaveBeenCalledWith("verified-original"); expect(f.store.restoreLocation).toHaveBeenCalledWith("selected");
});
it("rejects a foreign directory without committing or leaving the recovery window", async () => {
  const f = fixture(); f.store.inspectRecovery.mockRejectedValue(new Error("foreign")); f.ui.choose.mockResolvedValueOnce("locate").mockResolvedValueOnce("quit");
  expect(await f.run(vi.fn().mockRejectedValue(new Error()))).toBe(false); expect(f.store.restoreLocation).not.toHaveBeenCalled(); expect(f.ui.confirm).not.toHaveBeenCalled();
});
