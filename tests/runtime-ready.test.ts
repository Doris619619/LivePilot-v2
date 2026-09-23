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

/** 进程和控制端口是独立事实，查询失败不能宣称停播。 */
it.each([{pid:null,portPid:null,code:undefined,streaming:false},{pid:10,portPid:null,code:"OBS_NOT_LISTENING",streaming:null},{pid:null,portPid:11,code:"OBS_PORT",streaming:null},{pid:10,portPid:11,code:"OBS_PORT",streaming:null}])("distinguishes OBS process $pid and listener $portPid",async({pid,portPid,code,streaming})=>{const process=new ObsProcessManager();vi.spyOn(process,"inspect").mockResolvedValue({pid,portPid});const result=await new LocalObsRuntime(undefined,process).status();expect(result).toMatchObject({processKnown:true,ready:false,streaming});expect(result.problem?.code).toBe(code);});
it("marks process inspection failures unknown",async()=>{const process=new ObsProcessManager();vi.spyOn(process,"inspect").mockRejectedValue(new Error("SECRET"));const result=await new LocalObsRuntime(undefined,process).status();expect(result).toMatchObject({processKnown:false,streaming:null});expect(JSON.stringify(result)).not.toContain("SECRET");});
