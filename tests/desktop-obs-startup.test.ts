/** 隔离启动流程回归：真实阶段、统一时限、迟到响应和明确错误，不启动真实 OBS。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectObsForDesktop } from "../electron/obs-startup";
import { AppError } from "../src/core/errors";
import { ObsProcessManager } from "../src/core/obs/process";

/** 用虚拟时间跨越完整预算，依赖只返回合成观测。 */
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
/** 不留下时钟或原型探针影响其他测试。 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
/** 构造最小只读控制器，记录请求以防意外加入写操作。 */
function fixture() {
  const process = { ensureRunning: vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); }), inspect: vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); return { pid: 12 as number | null, portPid: 12 as number | null }; }) };
  const controller = { connect: vi.fn(async () => {}), call: vi.fn().mockResolvedValue({}), disconnect: vi.fn(async () => {}) };
  const report = vi.fn();
  return { process, controller, report };
}
it("reports real stages and only reads OBS status before confirming readiness", async () => {
  const f = fixture(); await connectObsForDesktop(f.process, f.controller, f.report);
  expect(f.report.mock.calls.map(([p]) => p.phase)).toEqual(["process", "control", "verify", "verify", "verify", "ready"]);
  expect(f.report.mock.calls[0][0].lastProbeAt).toBeUndefined();
  expect(f.report.mock.calls.at(-1)![0]).toMatchObject({ lastProbeAt: 100_000, deadlineAt: 160_000 });
  expect(f.controller.call.mock.calls.map(([name]) => name)).toEqual(["GetVersion", "GetCurrentProgramScene", "GetStreamStatus"]);
  expect(f.controller.disconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("reports actual repeated port observations while waiting, then completes", async () => {
  const f = fixture(); f.process.inspect.mockResolvedValueOnce({ pid: 12, portPid: null });
  const done = connectObsForDesktop(f.process, f.controller, f.report);
  await vi.advanceTimersByTimeAsync(1500); await done;
  expect(f.report.mock.calls[1][0]).toMatchObject({ phase: "control", lastProbeAt: 100_000, probeCount: 1 });
  expect(f.report.mock.calls.at(-1)![0].lastProbeAt).toBe(101_500);
  expect(f.process.ensureRunning).toHaveBeenCalledOnce();
});
it("stops waiting at the budget even when the initial process query never finishes", async () => {
  const f = fixture(); f.process.ensureRunning.mockImplementation(() => new Promise(() => {}));
  const result = expect(connectObsForDesktop(f.process, f.controller, f.report)).rejects.toMatchObject({ code: "OBS_READY" });
  await vi.advanceTimersByTimeAsync(60_000); await result;
  expect(f.process.ensureRunning.mock.calls[0][0]?.aborted).toBe(true);
  expect(f.process.inspect).not.toHaveBeenCalled(); expect(f.controller.call).not.toHaveBeenCalled();
});
it("does not accept a late successful read or execute the next request after timeout", async () => {
  const f = fixture(); let finish!: (value: object) => void;
  f.controller.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = expect(connectObsForDesktop(f.process, f.controller, f.report)).rejects.toMatchObject({ code: "OBS_READY" });
  await vi.advanceTimersByTimeAsync(60_000); await result;
  const count = f.report.mock.calls.length; finish({}); await vi.advanceTimersByTimeAsync(1);
  expect(f.report).toHaveBeenCalledTimes(count); expect(f.controller.call).toHaveBeenCalledTimes(1);
  expect(f.report.mock.calls.some(([p]) => p.phase === "ready")).toBe(false);
});
it.each(["OBS_AUTH", "OBS_PORT"])("ends immediately for actionable %s rather than retrying for a minute", async code => {
  const f = fixture(); f.controller.connect.mockRejectedValue(new AppError(code, "安全的配置错误"));
  await expect(connectObsForDesktop(f.process, f.controller, f.report)).rejects.toMatchObject({ code });
  expect(f.process.inspect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it("does not claim the process phase completed when only a spawn request succeeded", async () => {
  const f = fixture(); f.process.inspect.mockResolvedValueOnce({ pid: null, portPid: null });
  const done = connectObsForDesktop(f.process, f.controller, f.report);
  await vi.advanceTimersByTimeAsync(1500); await done;
  expect(f.report.mock.calls[1][0]).toMatchObject({ phase: "process", observation: "尚未检测到 OBS 进程，正在等待程序启动。" });
});
it("prevents a late process query from spawning after cancellation", async () => {
  const manager = new ObsProcessManager(); const cancellation = new AbortController();
  let finish!: (value: { pid: null; portPid: null }) => void;
  vi.spyOn(manager, "inspect").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const expected = expect(manager.ensureRunning(cancellation.signal)).rejects.toMatchObject({ name: "AbortError" });
  cancellation.abort(); finish({ pid: null, portPid: null }); await expected;
});
