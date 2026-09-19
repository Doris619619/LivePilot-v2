/** 原生端口解析与启动保护的回归；不启动真实进程。 */
import { expect, it, vi } from "vitest";
import { listenerPid, ObsProcessManager } from "@/server/obs/process";
import { matchingObsPid } from "@/core/obs/process";
const tcp = "TCP 0.0.0.0:4455 0.0.0.0:0 LISTENING 123";
/** Windows 可报告逻辑路径，文件系统却返回 MSIX 的真实路径；必须仍认出同一 OBS。 */
it("recognizes redirected OBS paths without claiming another installation", async () => {
  const output = JSON.stringify({ processes: [{ pid: 123, exe: "C:/Local/LiveNest/obs64.exe" }, { pid: 456, exe: "D:/Other/obs64.exe" }] });
  const resolve = async (filename: string) => filename.startsWith("C:") ? "C:/Packages/LocalCache/LiveNest/obs64.exe" : filename;
  await expect(matchingObsPid(output, "c:/packages/localcache/LiveNest/obs64.exe", resolve)).resolves.toBe(123);
});
/** 两个逻辑别名指向同一程序时，不任意选择一个进程。 */
it("rejects duplicate processes after canonicalization", async () => {
  await expect(matchingObsPid(JSON.stringify({ processes: [{ pid: 1, exe: "alias-a" }, { pid: 2, exe: "alias-b" }] }), "canonical", async () => "canonical")).rejects.toThrow("多个进程");
});
/** 不可访问或已退出的进程不能被认领；端口占用仍由 inspect/ensureRunning 阻止。 */
it("does not claim an inaccessible executable", async () => {
  await expect(matchingObsPid(JSON.stringify({ processes: [{ pid: 1, exe: "gone" }] }), "canonical", async () => { throw new Error("gone"); })).resolves.toBeNull();
  await expect(matchingObsPid('{"processes":[{"pid":0,"exe":"bad"}]}', "canonical")).rejects.toThrow("状态无效");
});
/** 同端口 IPv4/IPv6 的同一 PID 去重；其他端口和连接状态不计入。 */
it("finds only the local listening owner", () => {
  expect(listenerPid(tcp + "\nTCP [::]:4455 [::]:0 LISTENING 123\nTCP 127.0.0.1:9999 127.0.0.1:4455 ESTABLISHED 900\nTCP 0.0.0.0:4456 0.0.0.0:0 LISTENING 456", 4455)).toBe(123);
  expect(listenerPid("TCP 127.0.0.1:4455 127.0.0.1:123 ESTABLISHED 777", 4455)).toBeNull();
});
/** 未监听的端口不是查询错误，应允许进入后续进程启动检查。 */
it("accepts an empty listening table", () => { expect(listenerPid("Active Connections\nProto Local Address Foreign Address State PID", 4455)).toBeNull(); });
/** 不能静默选择多个进程中的任意一个。 */
it("rejects ambiguous or malformed ownership", () => {
  expect(() => listenerPid(tcp + "\nTCP 127.0.0.1:4455 0.0.0.0:0 LISTENING 999", 4455)).toThrow("多个");
  expect(() => listenerPid("TCP 0.0.0.0:4455 0.0.0.0:0 LISTENING invalid", 4455)).toThrow("归属");
});
/** 已运行实例直接复用，防止重复启动。 */
it("reuses the configured process", async () => {
  const manager = new ObsProcessManager();
  vi.spyOn(manager, "inspect").mockResolvedValue({ pid: 123, portPid: 123 });
  await expect(manager.ensureRunning()).resolves.toBeUndefined();
});
/** 即使 OBS 未运行也不能抢占其他进程的监听端口。 */
it("refuses a foreign listener before spawning", async () => {
  const manager = new ObsProcessManager();
  vi.spyOn(manager, "inspect").mockResolvedValue({ pid: null, portPid: 999 });
  await expect(manager.ensureRunning()).rejects.toThrow("其他进程");
});
