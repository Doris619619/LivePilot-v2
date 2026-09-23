/** Manager 迁移事务边界：关闭检查覆盖候选，失败恢复原 Agent，提交后恢复新位置。 */
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import path from "node:path";
import {AppError} from "../src/core/errors";
import {Manager} from "../electron/manager";
const f=vi.hoisted(()=>({write:vi.fn(),select:vi.fn(),copy:vi.fn(),preflight:vi.fn(),hasData:vi.fn(),inspect:vi.fn(),idle:vi.fn(),stop:vi.fn(),start:vi.fn(),ready:vi.fn(),rpc:vi.fn()}));
vi.mock("electron",()=>({app:{isPackaged:false,getVersion:()=>"fixture",getLoginItemSettings:()=>({})},session:{},net:{},shell:{},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:["D:/target"]}),showMessageBox:async()=>({response:1})}}));
vi.mock("node:fs/promises",()=>({mkdir:vi.fn(),access:vi.fn(async()=>{})}));
vi.mock("../electron/settings",()=>({SettingsStore:class{write=f.write;select=f.select;},environment:()=>({})}));
vi.mock("../electron/data-root",()=>({hasData:f.hasData,ordinaryPath:vi.fn()}));
vi.mock("../electron/data-location",()=>({copyDataLocation:f.copy,preflightDataLocation:f.preflight,MIGRATION_FILE:"migration.json"}));
vi.mock("../src/core/storage",()=>({Store:class{read=async()=>({stage:"ready-to-switch"});write=async()=>{};}}));
vi.mock("../src/core/obs/process",()=>({ObsProcessManager:class{inspect=f.inspect;}}));
vi.mock("../electron/obs-setup",()=>({assertLocalIdle:f.idle,initializeObs:vi.fn(),newInstance:vi.fn()}));
vi.mock("../electron/agent-host",()=>({AgentHost:class{child={};snapshots=[];stop=f.stop;start=f.start;ready=f.ready;rpc=f.rpc;}}));
vi.mock("../electron/updates",()=>({Updates:class{state={};}}));
vi.mock("../electron/diagnostics",()=>({diagnose:vi.fn()}));
let manager:Manager;
/** 使用假计时只跳过既有云端会话排空等待，外部服务均为 mock。 */
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();for(const fn of [f.write,f.stop,f.start,f.ready,f.rpc,f.preflight,f.idle])fn.mockResolvedValue(undefined);f.hasData.mockResolvedValue(true);f.inspect.mockResolvedValue({pid:null,portPid:null});f.copy.mockImplementation(async settings=>({...settings,dataRoot:path.join("D:/target","LiveNest"),rootId:"new-root"}));manager=new Manager("fixture",()=>{});manager.settings={dataRoot:"D:/source",rootId:"old-root",encryptionKey:"a".repeat(64),instances:[{id:"main",name:"OBS 1",exe:"D:/source/obs/main/bin/64bit/obs64.exe",managed:true,initialized:true,port:4455,password:"synthetic"}],paired:true,identity:{agentId:"fixture",token:"synthetic",origin:"https://example.invalid"}};});
/** 假计时不能泄漏给其他测试。 */
afterEach(()=>vi.useRealTimers());
it("rejects running archived OBS before stopping Agent",async()=>{manager.settings.archivedCandidates=[{...manager.settings.instances[0],id:"archive",initialized:false}];f.inspect.mockResolvedValueOnce({pid:null,portPid:null}).mockResolvedValueOnce({pid:123,portPid:123});await expect(manager.act("directory")).rejects.toThrow("包括待配置 OBS");expect(f.stop).not.toHaveBeenCalled();expect(f.copy).not.toHaveBeenCalled();});
it("rejects an invalid destination before maintenance",async()=>{f.preflight.mockRejectedValue(new Error("target collision"));await expect(manager.act("directory")).rejects.toThrow("执行结果需要核对");expect(f.rpc).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();});
it("restores old Agent and path when copying fails",async()=>{f.copy.mockRejectedValue(new Error("checksum mismatch"));const result=expect(manager.act("directory")).rejects.toThrow("执行结果需要核对");await Promise.all([vi.runAllTimersAsync(),result]);expect(manager.settings.dataRoot).toBe("D:/source");expect(f.start.mock.calls[0][0].dataRoot).toBe("D:/source");expect(manager.settings.identity?.agentId).toBe("fixture");});
it("does not switch in-memory path when the configuration commit fails",async()=>{f.write.mockImplementation(async settings=>{if(settings.rootId==="new-root")throw new Error("configuration unavailable");});const result=expect(manager.act("directory")).rejects.toThrow("执行结果需要核对");await Promise.all([vi.runAllTimersAsync(),result]);expect(manager.settings.rootId).toBe("old-root");expect(f.start.mock.calls[0][0].dataRoot).toBe("D:/source");});
it("retains committed new location and maintenance when Agent readiness fails",async()=>{f.ready.mockRejectedValue(new Error("new connection unavailable"));const result=expect(manager.act("directory")).rejects.toThrow("数据已切换到新位置，无需再次迁移");await Promise.all([vi.runAllTimersAsync(),result]);expect(manager.settings.rootId).toBe("new-root");expect(manager.settings.maintenance).toBeTruthy();expect(f.rpc.mock.calls.some(([route])=>route==="maintenance-end")).toBe(false);});

/** 次要重连错误不得掩盖原复制失败及其阶段。 */
it("preserves copy failure when reconnect also fails",async()=>{f.copy.mockImplementation(async(_settings,_target,progress)=>{progress("校验复制文件");throw new AppError("DATA","复制校验失败");});f.ready.mockRejectedValue(new Error("private reconnect detail"));const result=expect(manager.act("directory")).rejects.toMatchObject({problem:{code:"DATA",stage:"校验复制文件",outcome:"unknown",message:expect.stringContaining("复制校验失败")}});await Promise.all([vi.runAllTimersAsync(),result]);expect(manager.settings.rootId).toBe("old-root");expect(manager.activity.value?.problem?.message).not.toContain("private");});
