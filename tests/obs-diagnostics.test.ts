/** 诊断按具体证据分流操作，未启动和未知不会误称防火墙故障。 */
import { beforeEach,it,expect,vi } from "vitest";
const mock=vi.hoisted(()=>({inspect:vi.fn(),call:vi.fn(),exec:vi.fn()}));
vi.mock("../src/core/obs/process",()=>({ObsProcessManager:class{inspect=mock.inspect;}}));
vi.mock("../src/core/obs/controller",()=>({ObsController:class{call=mock.call;disconnect=async()=>{};}}));
vi.mock("node:util",()=>({promisify:()=> (...args:unknown[])=>new Promise((resolve,reject)=>mock.exec(...args,(e:Error|null,stdout:string,stderr:string)=>e?reject(e):resolve({stdout,stderr})))}));
vi.mock("node:child_process",()=>({execFile:(...args:unknown[])=>mock.exec(...args)}));
import { checkObsNetwork } from "../electron/obs-network";
import { AppError } from "../src/core/errors";
const item={id:"main",name:"OBS 1",managed:true,exe:"D:/OBS/bin/64bit/obs64.exe",port:4455,password:"synthetic",initialized:true};
beforeEach(()=>{mock.inspect.mockResolvedValue({pid:123,portPid:123});mock.call.mockResolvedValue({});mock.exec.mockImplementation((...args:unknown[])=>{const cb=args.at(-1) as (e:null,out:string,err:string)=>void;cb(null,"TCP 127.0.0.1:4455 0.0.0.0:0 LISTENING 123","");});});
it("offers launch for stopped OBS without reporting firewall failure",async()=>{mock.inspect.mockResolvedValue({pid:null,portPid:null});expect(await checkObsNetwork(item)).toMatchObject({status:"pending",code:"not-running",action:"launch",instanceId:"main"});});
it("distinguishes another process and absent listener",async()=>{mock.inspect.mockResolvedValue({pid:123,portPid:456});expect(await checkObsNetwork(item)).toMatchObject({code:"port-conflict",action:"repair"});mock.inspect.mockResolvedValue({pid:123,portPid:null});expect(await checkObsNetwork(item)).toMatchObject({code:"not-listening"});});
it.each(["OBS_AUTH","OBS_TIMEOUT"])("preserves connection cause %s",async code=>{mock.call.mockRejectedValue(new AppError(code,"安全提示"));expect(await checkObsNetwork(item)).toMatchObject({code,status:"error"});});
it("shows unknown on query failure and confirms only actual loopback listeners",async()=>{expect(await checkObsNetwork(item)).toMatchObject({status:"ready"});mock.inspect.mockRejectedValue(new Error("access denied"));expect(await checkObsNetwork(item)).toMatchObject({status:"pending",code:"inspection-unavailable",action:"retry"});});
