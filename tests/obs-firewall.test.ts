/** 防火墙辅助任务不会阻塞控制；失败只产生技术报告，路径校验在提权前完成。 */
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ exec: vi.fn(), ordinary: vi.fn(), read: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => mock.exec }));
vi.mock("../electron/data-root", () => ({ ordinaryEntry: mock.ordinary, ordinaryPath: mock.ordinary, readRoot: async () => ({ id: "12345678-1234-1234-1234-123456789012" }) }));
vi.mock("node:fs/promises", () => ({ readFile: mock.read }));
import { inspectFirewall, firewallChecks, protectObs, firewallFingerprint } from "../electron/obs-firewall";
import type { Settings } from "../electron/settings";
import path from "node:path";
/** 路径由当前操作系统构造；测试不实际提权或修改防火墙。 */
function settings(id: string): Settings { const root = path.resolve(".data", "firewall-test"); return { dataRoot: root, rootId: "12345678-1234-1234-1234-123456789012", encryptionKey: "synthetic", instances: [{ id, name: id, managed: true, initialized: true, exe: path.join(root, "obs", id, "bin", "64bit", "obs64.exe"), port: 4455, password: "synthetic" }] }; }
beforeEach(() => { mock.exec.mockReset(); mock.ordinary.mockImplementation(async (value: string) => value); mock.read.mockResolvedValue("main"); });
it("returns immediately while security query remains pending and merges duplicate reads", async () => {
  const item = settings("slow").instances[0]; let finish!: (value: unknown) => void;
  mock.exec.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  expect(inspectFirewall(item)).toBeUndefined(); inspectFirewall(item); expect(mock.exec).toHaveBeenCalledOnce();
  finish({ stdout: '{"isolated":false}' }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(firewallChecks([item])[0]).toMatchObject({ code: "firewall-unconfirmed", status: "pending" });
});
it("rejects a managed path mismatch without starting an elevated process", async () => {
  const state = settings("outside"); state.instances[0].exe = path.resolve("other.exe");
  await protectObs(state, "resources"); expect(mock.exec).not.toHaveBeenCalled();
  expect(firewallChecks(state.instances)[0].status).toBe("pending");
});
it("treats denied system authorization as an advisory and does not throw", async () => {
  const state = settings("main"); mock.exec.mockRejectedValue(new Error("cancelled"));
  await expect(protectObs(state, "resources")).resolves.toBeUndefined();
  expect(mock.exec.mock.calls[0][1].join(" ")).toContain("-Verb RunAs -WindowStyle Hidden");
  expect(firewallChecks(state.instances)[0]).toMatchObject({ status: "pending", code: "firewall-unconfirmed" });
});
it("invalidates protection fingerprint on program or port change but not password", () => {
  const state = settings("main"); const first = firewallFingerprint(state); state.instances[0].password = "another"; expect(firewallFingerprint(state)).toBe(first);
  state.instances[0].port++; expect(firewallFingerprint(state)).not.toBe(first);
});
