/** 真实 Manager 的更新分支回归：不因缺少目录或撤销配对退回云端维护。 */
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ idle: vi.fn().mockResolvedValue(undefined) }));
vi.mock("electron", () => ({ app: {}, dialog: {}, net: {}, session: {}, shell: {}, safeStorage: {} }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
vi.mock("../electron/obs-setup", () => ({ assertLocalIdle: mock.idle }));
import { Manager } from "../electron/manager";
import { Activity } from "../electron/activity";
import type { DesktopState } from "../src/shared/desktop";
it.each([false, true])("installs with paired=%s without cloud RPC or modifying maintenance", async paired => {
  mock.idle.mockClear(); const settings = { dataRoot: "", instances: [], candidates: [{ id: "candidate" }], archivedCandidates: [{ id: "archived" }], paired, maintenance: "existing-lease", inventoryPending: true };
  const before = structuredClone(settings); const rpc = vi.fn().mockRejectedValue(new Error("revoked device")); const stop = vi.fn().mockResolvedValue(undefined); const flush = vi.fn().mockResolvedValue(undefined); const allowQuit = vi.fn(); const write = vi.fn();
  const host = Object.assign(Object.create(Manager.prototype), { settings, busy: false, activity: new Activity(), store: { flush, write }, agent: { stop, rpc }, allowQuit, updates: { install: async (prepare: () => Promise<void>, quit: () => void) => { await prepare(); quit(); return true; } }, state: () => ({ activity: host.activity.value }) as DesktopState });
  await host.act("update-install"); expect(stop).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce(); expect(allowQuit).toHaveBeenCalledOnce(); expect(rpc).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(settings).toEqual(before); expect(mock.idle).toHaveBeenCalledTimes(2); expect(mock.idle.mock.calls[0][0].instances.map((i: { id: string }) => i.id)).toEqual(["candidate", "archived"]); expect(host.activity.value.status).toBe("complete");
});
