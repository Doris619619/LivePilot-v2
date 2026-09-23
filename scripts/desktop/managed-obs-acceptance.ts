/** 隔离 Windows 三 OBS 验收：只创建和验证，从不授权、配对、录制或推流。 */
import {mkdir,writeFile,readFile,mkdtemp} from "node:fs/promises";
import path from "node:path";import {promisify} from "node:util";import {execFile} from "node:child_process";
import {newInstance,initializeObs,freePort} from "../../electron/obs-setup";
import {environment,type Settings} from "../../electron/settings";
import {claimRoot} from "../../electron/data-root";
import {configureCore,config} from "../../src/core/config";
import {ObsController} from "../../src/core/obs/controller";
import {ObsProcessManager} from "../../src/core/obs/process";
const exec=promisify(execFile);
/** 独立目录和高端口避开本机现有实例；清理只关闭已验证且无输出的测试进程；隐藏测试窗口无法优雅关闭时才终止测试 PID。 */
async function run(){
 const parent=path.resolve(".data/qa");await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,"managed-"));const marker=await claimRoot(root);
 const settings:Settings={dataRoot:root,rootId:marker.id,instances:[],encryptionKey:"a".repeat(64)};
 const results:{root:string;result:string;instances:{id:string;port:number;validated:boolean;streaming:boolean;recording:boolean}[];error?:string;closed:number}={root,result:"running",instances:[],closed:0};
 const connections:ObsController[]=[];
 try {
  const credential=path.join(root,"state","synthetic-authorization.enc");await mkdir(path.dirname(credential),{recursive:true});await writeFile(credential,"synthetic unchanged authorization");
  let firstScene:unknown;
  for(let n=0;n<3;n++){
   const item=await newInstance(settings);item.port=await freePort(settings.instances.map(i=>i.port),15455);settings.instances.push(item);
   await initializeObs(settings,item,path.resolve("desktop-resources"),stage=>console.log("OBS "+(n+1)+": "+stage));item.initialized=true;
   configureCore(()=>environment(settings));const controller=new ObsController(()=>config(item.id));connections.push(controller);await controller.validate();
   const stream=await controller.call("GetStreamStatus");const recording=await controller.call("GetRecordStatus");if(stream.outputActive||recording.outputActive)throw new Error("Creation unexpectedly activated output");
   if(n===0){await controller.call("CreateScene",{sceneName:"KEEP_FIRST_SCENE"});firstScene=await controller.call("GetSceneList");}
   else if(JSON.stringify(await connections[0].call("GetSceneList"))!==JSON.stringify(firstScene))throw new Error("Existing scene changed");
   if(await readFile(credential,"utf8")!=="synthetic unchanged authorization")throw new Error("Existing credentials changed");
   results.instances.push({id:item.id,port:item.port,validated:true,streaming:false,recording:false});
  }
  if(new Set(settings.instances.map(i=>i.exe)).size!==3||new Set(settings.instances.map(i=>i.password)).size!==3||new Set(settings.instances.map(i=>i.port)).size!==3)throw new Error("Isolation failed");
  results.result="passed";
 }catch(error){results.result="failed";results.error=error instanceof Error?error.message:"Unknown";process.exitCode=1;}
 finally{
  configureCore(()=>environment(settings));
  for(let n=0;n<settings.instances.length;n++){
   const item=settings.instances[n];const controller=connections[n]||new ObsController(()=>config(item.id));
   try {
    if(!item.exe.startsWith(root+path.sep))throw new Error("Unsafe process ownership");
    if((await controller.call("GetStreamStatus")).outputActive||(await controller.call("GetRecordStatus")).outputActive)throw new Error("Output active; leave process for inspection");
    const processState=await new ObsProcessManager(()=>config(item.id)).inspect();await controller.disconnect();
    if(processState.pid){await exec("powershell.exe",["-NoProfile","-NonInteractive","-Command","$p=Get-Process -Id $env:LN_QA_PID; if([IO.Path]::GetFullPath($p.Path) -ne [IO.Path]::GetFullPath($env:LN_QA_EXE)){throw 'ownership mismatch'}; [void]$p.CloseMainWindow(); if(-not $p.WaitForExit(3000)){Stop-Process -Id $p.Id; if(-not $p.WaitForExit(5000)){throw 'Owned test process did not exit'}}"],{windowsHide:true,env:{...process.env,LN_QA_PID:String(processState.pid),LN_QA_EXE:item.exe},timeout:20000});results.closed++;}
   }catch{results.result="failed";results.error="测试 OBS 未能安全关闭，请检查隔离验收目录。";process.exitCode=1;}finally{await controller.disconnect();}
  }
  await writeFile(path.join(root,"result.json"),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }
}
void run().catch(()=>{console.error("隔离 OBS 验收启动失败");process.exitCode=1;});
