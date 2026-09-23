/** 在 Windows 运行安装器校验脚本；只传测试 AppData 和隔离路径。 */
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {execFile} from "node:child_process";import {promisify} from "node:util";
import path from "node:path";import os from "node:os";
import {it,expect} from "vitest";
const exec=promisify(execFile);
it.skipIf(process.platform!=="win32")("validates paths, persists only the locator, and preserves it on upgrades",async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),"ln-installer-"));
 try {
  const bootstrap=path.join(base,"profile"); const target=path.join(base,"中文 空格","LiveNest");const installed=path.join(base,"program");const result=path.join(base,"result.ini");
  await mkdir(path.dirname(target));
  /** 参数使用 execFile 数组，不通过 shell 拼接。 */
  const run=(mode:string,selected=target,install=installed)=>exec("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.resolve("scripts/desktop/data-location.ps1"),"-Mode",mode,"-Bootstrap",bootstrap,"-Target",selected,"-Installation",install,"-Result",result],{windowsHide:true});
  await run("Validate");expect(await readFile(result,"utf16le")).toContain(target);
  await expect(run("Validate",target,target)).rejects.toThrow();
  const unknown=path.join(base,"unknown");await mkdir(unknown);await writeFile(path.join(unknown,"keep.txt"),"user");await expect(run("Validate",unknown)).rejects.toThrow();expect(await readFile(path.join(unknown,"keep.txt"),"utf8")).toBe("user");
  await run("Persist");const location=await readFile(path.join(bootstrap,"data-location.json"),"utf8");expect(JSON.parse(location)).toEqual({version:1,dataRoot:target,pending:true});
  // pending 新安装尚未启动时，后续安装也应沿用选择，而非要求磁盘中已有根目录。
  await run("Persist");expect(await readFile(path.join(bootstrap,"data-location.json"),"utf8")).toBe(location);
  await expect(run("Persist",path.join(base,"other"))).rejects.toThrow();
 } finally {if(path.dirname(base)!==os.tmpdir()||!path.basename(base).startsWith("ln-installer-"))throw new Error("Unsafe cleanup");await rm(base,{recursive:true,force:true});}
},30000);
