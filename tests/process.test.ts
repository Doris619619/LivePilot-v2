/** 原生端口解析与启动保护的回归；不启动真实进程。 */
import { expect, it, vi } from "vitest";
import { listenerPid, ObsProcessManager } from "@/server/obs/process";
import { matchingObsPid } from "@/core/obs/process";
const tcp = "TCP 0.0.0.0:4455 0.0.0.0:0 LISTENING 123";
/** 不接受未查询成功的缺失、字符串或非法 PID。 */
it("accepts only a validated native process result", () => {
  expect(matchingObsPid('{"pid":123}')).toBe(123);
  expect(matchingObsPid('{"pid":null}')).toBeNull();
  for (const result of ['{}', '{"pid":0}', '{"pid":"123"}', 'invalid']) expect(() => matchingObsPid(result)).toThrow("状态无效");
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
