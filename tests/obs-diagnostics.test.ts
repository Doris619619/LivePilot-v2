/** 诊断按具体证据分流操作，未启动和未知不会误称防火墙故障。 */
import { afterEach,beforeEach,it,expect,vi } from "vitest";
const mock=vi.hoisted(()=>({inspect:vi.fn(),connect:vi.fn(),call:vi.fn(),disconnect:vi.fn(),exec:vi.fn()}));
vi.mock("../src/core/obs/process",()=>({ObsProcessManager:class{inspect=mock.inspect;}}));
vi.mock("../src/core/obs/controller",()=>({ObsController:class{connect=mock.connect;call=mock.call;disconnect=mock.disconnect;}}));
vi.mock("../electron/obs-firewall",()=>({inspectFirewall:vi.fn()}));
vi.mock("node:util",()=>({promisify:()=> (...args:unknown[])=>new Promise((resolve,reject)=>mock.exec(...args,(e:Error|null,stdout:string,stderr:string)=>e?reject(e):resolve({stdout,stderr})))}));
vi.mock("node:child_process",()=>({execFile:(...args:unknown[])=>mock.exec(...args)}));
import { checkObsNetwork } from "../electron/obs-network";
import { AppError } from "../src/core/errors";
import { Activity } from "../electron/activity";
import type { ObsStartupProgress } from "../src/shared/obs-startup";
import { inspectFirewall } from "../electron/obs-firewall";
const item={id:"main",name:"OBS 1",managed:true,exe:"D:/OBS/bin/64bit/obs64.exe",port:4455,password:"synthetic",initialized:true};
beforeEach(()=>{mock.inspect.mockResolvedValue({pid:123,portPid:123});mock.connect.mockResolvedValue(undefined);mock.disconnect.mockResolvedValue(undefined);mock.call.mockResolvedValue({});mock.exec.mockImplementation((...args:unknown[])=>{const cb=args.at(-1) as (e:null,out:string,err:string)=>void;cb(null,"TCP 127.0.0.1:4455 0.0.0.0:0 LISTENING 123","");});});
/** 虚拟截止计时不得泄漏到其他诊断测试。 */
afterEach(()=>vi.useRealTimers());
it("offers launch for stopped OBS without reporting firewall failure",async()=>{mock.inspect.mockResolvedValue({pid:null,portPid:null});expect(await checkObsNetwork(item)).toMatchObject({status:"pending",code:"not-running",action:"launch",instanceId:"main"});});
it("distinguishes another process and absent listener",async()=>{mock.inspect.mockResolvedValue({pid:123,portPid:456});expect(await checkObsNetwork(item)).toMatchObject({code:"port-conflict",action:"repair"});mock.inspect.mockResolvedValue({pid:123,portPid:null});expect(await checkObsNetwork(item)).toMatchObject({code:"not-listening"});});
it.each(["OBS_AUTH","OBS_TIMEOUT"])("preserves connection cause %s",async code=>{mock.call.mockRejectedValue(new AppError(code,"安全提示"));expect(await checkObsNetwork(item)).toMatchObject({code,status:"error"});});
it("shows unknown on query failure and confirms only actual loopback listeners",async()=>{expect(await checkObsNetwork(item)).toMatchObject({status:"ready"});mock.inspect.mockRejectedValue(new Error("access denied"));expect(await checkObsNetwork(item)).toMatchObject({status:"pending",code:"inspection-unavailable",action:"retry"});});
it("keeps verified control separate from uncertain firewall isolation",async()=>{
  mock.exec.mockImplementation((...args:unknown[])=>{const cb=args.at(-1) as (e:null,out:string,err:string)=>void;cb(null,args[0]==="netstat.exe"?"TCP 0.0.0.0:4455 0.0.0.0:0 LISTENING 123":'{"isolated":false}',"");});
  expect(await checkObsNetwork(item)).toMatchObject({controlReady:true,status:"ready"});
  mock.inspect.mockResolvedValue({pid:null,portPid:null});expect(await checkObsNetwork(item)).toMatchObject({controlReady:false,code:"not-running"});
});
it("reports actual process, connection and read phases using one host deadline",async()=>{
  vi.useFakeTimers();vi.setSystemTime(100_000);
  const report=vi.fn();
  expect(await checkObsNetwork(item,{report})).toMatchObject({controlReady:true,status:"ready",checkedAt:100_000});
  expect(report.mock.calls.map(([p])=>p.phase)).toEqual(["process","control","verify","ready"]);
  expect(report.mock.calls[0][0]).toMatchObject({deadlineAt:115_000,probeCount:0});
  expect(report.mock.calls[0][0].lastProbeAt).toBeUndefined();
  expect(report.mock.calls.at(-1)![0]).toMatchObject({deadlineAt:115_000,lastProbeAt:100_000});
  expect(mock.call.mock.calls.map(([name])=>name)).toEqual(["GetVersion"]);
  expect(mock.disconnect).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it("cancels a hung process inspection at 15 seconds without connecting or launching",async()=>{
  vi.useFakeTimers();vi.setSystemTime(100_000);
  mock.inspect.mockImplementation(()=>new Promise(()=>{}));
  const result=expect(checkObsNetwork(item)).resolves.toMatchObject({code:"OBS_DIAGNOSIS_TIMEOUT",controlReady:false,status:"pending",checkedAt:115_000});
  await vi.advanceTimersByTimeAsync(15_000);await result;
  expect(mock.inspect.mock.calls[0][0].aborted).toBe(true);
  expect(mock.connect).not.toHaveBeenCalled();expect(mock.call).not.toHaveBeenCalled();
});
it.each(["connect","call"] as const)("ignores a late %s success and disconnects instead of confirming readiness",async phase=>{
  vi.useFakeTimers();vi.setSystemTime(100_000);
  let finish!:(value:object)=>void;
  mock[phase].mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const report=vi.fn();const pending=checkObsNetwork(item,{report});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({code:"OBS_DIAGNOSIS_TIMEOUT",controlReady:false});
  const count=report.mock.calls.length;finish({});await vi.advanceTimersByTimeAsync(1);
  expect(report).toHaveBeenCalledTimes(count);
  expect(report.mock.calls.some(([p])=>p.phase==="ready")).toBe(false);
  expect(mock.call).toHaveBeenCalledTimes(phase==="call"?1:0);
  expect(inspectFirewall).not.toHaveBeenCalled();expect(mock.disconnect).toHaveBeenCalled();
});
it("rejects diagnosis progress from another attempt or after terminal status",()=>{
  const activity=new Activity();activity.begin("diagnose-obs","main");const attempt=activity.value!.attemptId!;
  const progress:ObsStartupProgress={phase:"control",deadlineAt:Date.now()+15_000,probeCount:1};
  activity.diagnosis(attempt,"连接控制服务",progress);expect(activity.value!.obsDiagnosis).toEqual(progress);
  activity.complete();activity.diagnosis(attempt,"迟到",{...progress,phase:"ready"});
  expect(activity.value!.obsDiagnosis!.phase).toBe("control");
  activity.begin("diagnose-obs","second");activity.diagnosis(attempt,"旧轮次",progress);expect(activity.value!.obsDiagnosis).toBeUndefined();
  activity.begin("launch-obs","main");activity.diagnosis(activity.value!.attemptId!,"错误动作",progress);expect(activity.value!.obsDiagnosis).toBeUndefined();
});
