/** 本机 OBS 发现与导入校验；扫描只读，候选路径不授予任意文件执行权限。 */
import { readdir, realpath, stat, access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ObsScan, ObsCandidate } from "../src/shared/desktop";
const exec = promisify(execFile);
/** 查询固定脚本，路径通过环境传递，避免 shell 插值。 */
async function powershell(script:string, env:Record<string,string>={}) { const r=await exec("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:15000,maxBuffer:4*1024*1024,env:{...process.env,...env}});return JSON.parse(r.stdout.replace(/^\uFEFF/,"")); }
/** 必须是完整的 x64 OBS 28+ 安装，不能只复制单个 exe。 */
export async function inspectObs(filename:string):Promise<ObsCandidate> {
 const exe=await realpath(filename); if(path.basename(exe).toLowerCase()!=="obs64.exe" || !(await stat(exe)).isFile())throw new Error("请选择 OBS 的 obs64.exe。");
 const root=path.resolve(exe,"../../..");
 for(const f of ["bin/64bit/obs.dll","data/obs-studio","obs-plugins/64bit/obs-websocket.dll"]) await access(path.join(root,f)).catch(()=>{throw new Error("OBS 程序目录不完整或缺少 WebSocket v5，请选择完整安装目录或使用内置 OBS。");});
 const meta=await powershell("$v=(Get-Item -LiteralPath $env:LN_SCAN_EXE).VersionInfo; $running=@(Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:LN_SCAN_EXE }).Count -gt 0; @{version=$v.ProductVersion;running=$running}|ConvertTo-Json -Compress",{LN_SCAN_EXE:exe});
 const version=String(meta.version||""); if(!/^\d+/.test(version)||parseInt(version)<28)throw new Error("此 OBS 版本不支持当前连接方式，请使用 OBS 28 或以上版本，或使用内置 OBS。");
 return {exe,version,running:!!meta.running,attached:false};
}
export class ObsDiscovery {
 state:ObsScan={running:false,canceled:false,deep:false,results:[],drives:[],completedDrives:[],inaccessible:[],visited:0}; private stopped=false;
 /** 开始后台只读扫描，轮询可以读取增量结果。 */
 start(deep:boolean,attached:string[]){if(this.state.running)return;this.stopped=false;this.state={running:true,canceled:false,deep,results:[],drives:[],completedDrives:[],inaccessible:[],visited:0};void this.run(deep,attached).catch(()=>{this.state.error="扫描未完成，可重试或浏览选择 obs64.exe。";}).finally(()=>{this.state.running=false;this.state.current=undefined;});}
 /** 取消只停止遍历，保留已找到的候选。 */
 cancel(){this.stopped=true;this.state.canceled=true;}
 /** 真实路径去重，并把不兼容的候选显示为不可导入而非静默丢弃。 */
 private async candidate(filename:string,attached:string[]){if(this.stopped)return;let exe:string;try{exe=await realpath(filename);}catch{return;}if(this.state.results.some(c=>c.exe.toLowerCase()===exe.toLowerCase()))return;try{const value=await inspectObs(exe);value.attached=attached.some(a=>a.toLowerCase()===exe.toLowerCase());this.state.results.push(value);}catch(e){this.state.results.push({exe,version:"未知",running:false,attached:false,error:(e as Error).message});}}
 /** 不跟随目录联接或符号链接；访问失败列出，结果不能声称覆盖未读目录。 */
 async walk(root:string,attached:string[]){const stack=[root];while(stack.length&&!this.stopped){const dir=stack.pop()!;this.state.current=dir;this.state.visited++;let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{if(this.state.inaccessible.length<1000)this.state.inaccessible.push(dir);continue;}for(const e of entries){if(this.stopped)break;const f=path.join(dir,e.name);if(e.isFile()&&e.name.toLowerCase()==="obs64.exe")await this.candidate(f,attached);else if(e.isDirectory()&&!e.isSymbolicLink()){if(["windows","$recycle.bin","system volume information"].includes(e.name.toLowerCase())){if(this.state.inaccessible.length<1000)this.state.inaccessible.push(f+"（系统目录跳过）");}else stack.push(f);}else if(e.isSymbolicLink()&&this.state.inaccessible.length<1000)this.state.inaccessible.push(f+"（目录链接跳过）");}}}
 /** 先查询进程和安装记录，快速模式扫描常见目录；完整模式遍历所有固定盘。 */
 private async run(deep:boolean,attached:string[]){
 const raw=await powershell(String.raw`$drives=@([System.IO.DriveInfo]::GetDrives() | Where-Object {$_.DriveType -eq 'Fixed' -and $_.IsReady} | ForEach-Object {$_.Name}); $paths=@(Get-Process obs64 -ErrorAction SilentlyContinue | ForEach-Object {$_.Path}); foreach($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')){Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -like '*OBS Studio*'} | ForEach-Object {if($_.InstallLocation){$paths+=Join-Path $_.InstallLocation 'bin\64bit\obs64.exe'}}}; @{drives=$drives;paths=$paths}|ConvertTo-Json -Compress`);
 this.state.drives=raw.drives||[];for(const f of [...(raw.paths||[]),...attached])if(f)await this.candidate(f,attached);
 for(const drive of this.state.drives){if(this.stopped)break;if(deep)await this.walk(drive,attached);else for(const folder of ["Program Files/obs-studio","Program Files (x86)/obs-studio","OBS","obs-studio","LiveNest"]){const root=path.join(drive,folder);if(await access(root).then(()=>true,()=>false))await this.walk(root,attached);}if(!this.stopped)this.state.completedDrives.push(drive);}
 }
}
