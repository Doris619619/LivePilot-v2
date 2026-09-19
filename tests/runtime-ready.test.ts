/** 等待超时保留最后一个实际诊断原因，避免统一误导为密码错误。 */
import { expect, it, vi } from "vitest";
import { LocalObsRuntime } from "../src/core/obs/runtime";
import { ObsProcessManager } from "../src/core/obs/process";
it("reports the final readiness diagnosis after timeout", async () => {
  vi.useFakeTimers();
  try {
    const process = new ObsProcessManager(); vi.spyOn(process, "ensureRunning").mockResolvedValue();
    const runtime = new LocalObsRuntime(undefined, process);
    vi.spyOn(runtime, "status").mockResolvedValue({ ready: false, running: true, streaming: null, message: "端口不属于指定 OBS" });
    const result = expect(runtime.ensureReady()).rejects.toThrow("最后检查结果：端口不属于指定 OBS");
    await vi.advanceTimersByTimeAsync(65_000); await result;
  } finally { vi.useRealTimers(); }
});
