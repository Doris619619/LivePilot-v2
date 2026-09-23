/** 离线更新安全回归；全部进程与 OBS 状态为合成值，不操作真实直播。 */
import { expect, it, vi } from "vitest";
import { runLocalUpdate } from "../electron/local-update";
import { UpdateAccess } from "../electron/update-access";
import { AppError } from "../src/core/errors";
import type { DesktopState } from "../src/shared/desktop";
/** 按真实安装准备回调顺序模拟，独立记录 Agent 与文件写入。 */
function target() { return { wasRunning: true, checkIdle: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), flush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), reconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), install: vi.fn(async (prepare: () => Promise<void>) => { await prepare(); return true; }) }; }
it("updates offline without cloud maintenance and checks again after draining accepted tasks", async () => {
  const local = target(); await runLocalUpdate(local);
  expect(local.checkIdle).toHaveBeenCalledTimes(2); expect(local.checkIdle.mock.invocationCallOrder[0]).toBeLessThan(local.stop.mock.invocationCallOrder[0]); expect(local.stop.mock.invocationCallOrder[0]).toBeLessThan(local.checkIdle.mock.invocationCallOrder[1]); expect(local.checkIdle.mock.invocationCallOrder[1]).toBeLessThan(local.flush.mock.invocationCallOrder[0]); expect(local.reconnect).not.toHaveBeenCalled();
});
it.each(["streaming", "recording", "unknown"])("leaves the agent and OBS untouched when %s", async reason => {
  const local = target(); local.checkIdle.mockRejectedValueOnce(new AppError("OBS_MAINTENANCE", "OBS 1 " + reason));
  await expect(runLocalUpdate(local)).rejects.toThrow(reason); expect(local.stop).not.toHaveBeenCalled(); expect(local.reconnect).not.toHaveBeenCalled(); expect(local.flush).not.toHaveBeenCalled();
});
it("does not restart a still-draining agent after stop timeout", async () => {
  const local = target(); local.stop.mockRejectedValueOnce(new AppError("AGENT_CONNECTION", "Agent 仍在处理任务"));
  await expect(runLocalUpdate(local)).rejects.toThrow("任务"); expect(local.reconnect).not.toHaveBeenCalled(); expect(local.checkIdle).toHaveBeenCalledOnce();
});
it.each(["late-stream", "save", "installer"])("recovers the original agent without hiding %s failure", async phase => {
  const local = target(); const error = new AppError("OBS_MAINTENANCE", "original failure");
  if (phase === "late-stream") local.checkIdle.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
  if (phase === "save") local.flush.mockRejectedValueOnce(error);
  if (phase === "installer") local.install.mockImplementationOnce(async prepare => { await prepare(); throw error; });
  await expect(runLocalUpdate(local)).rejects.toBe(error); expect(local.reconnect).toHaveBeenCalledOnce();
});
it("retains both original and reconnect failures and never starts a previously stopped agent", async () => {
  const local = target(); local.flush.mockRejectedValue(new AppError("STORAGE_SPACE", "磁盘空间不足")); local.reconnect.mockRejectedValue(new Error("private"));
  await expect(runLocalUpdate(local)).rejects.toMatchObject({ code: "STORAGE_SPACE", message: expect.stringMatching(/磁盘空间不足.*Agent 连接未恢复/) });
  local.wasRunning = false; local.reconnect.mockClear(); await expect(runLocalUpdate(local)).rejects.toThrow("磁盘空间不足"); expect(local.reconnect).not.toHaveBeenCalled();
});
it("cancellation never checks, drains, writes or restarts", async () => {
  const local = target(); local.install.mockResolvedValueOnce(false); expect(await runLocalUpdate(local)).toBe(false);
  for (const call of [local.checkIdle, local.stop, local.flush, local.reconnect]) expect(call).not.toHaveBeenCalled();
});
it("local access only exposes version/busy/update, rejects non-update commands and preserves cancellation", async () => {
  const full = { dataRoot: "private-path", agentId: "private-device", instances: ["private-instance"], activity: { status: "cancelled" } } as unknown as DesktopState;
  const host = { busy: false, updates: { state: { status: "downloaded" } }, act: vi.fn().mockResolvedValue(full) };
  const access = new UpdateAccess(host, () => "0.1.4"); expect(Object.keys(access.state()).sort()).toEqual(["busy", "update", "version"]);
  for (const name of ["pair", "directory", "web", "start", "__proto__", undefined]) expect((await access.act(name)).ok).toBe(false);
  expect(host.act).not.toHaveBeenCalled(); expect(await access.act("update-install")).toMatchObject({ ok: true, cancelled: true }); expect(JSON.stringify(await access.act("update-check"))).not.toContain("private");
});
