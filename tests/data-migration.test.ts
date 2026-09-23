/** 复制校验与素材重定位回归；中断不切换、旧文件始终保留。 */
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath } from "node:fs/promises";
import path from "node:path";import os from "node:os";
import {beforeEach,afterEach,it,expect} from "vitest";
import {copyDataLocation,MIGRATION_FILE} from "../electron/data-location";
import {claimRoot} from "../electron/data-root";
import type {Settings} from "../electron/settings";
let base:string;let source:string;let target:string;let settings:Settings;let scene:string;
/** 构造真实目录层级和合成授权，不启动 OBS。 */
beforeEach(async()=>{base=await mkdtemp(path.join(os.tmpdir(),"ln-migrate-"));source=path.join(base,"旧目录");target=path.join(base,"新目录");const marker=await claimRoot(source);const exe=path.join(source,"obs/main/bin/64bit/obs64.exe");await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,"fixture");scene=path.join(source,"obs/main/config/obs-studio/basic/scenes/LiveNest.json");await mkdir(path.dirname(scene),{recursive:true});await writeFile(scene,JSON.stringify({name:source,sources:[{settings:{local_file:path.join(source,"media/main/videos/a.mp4")}}]}));await mkdir(path.join(source,"state"));await writeFile(path.join(source,"state/youtube.enc"),"synthetic-token-ciphertext");settings={rootId:marker.id,dataRoot:source,encryptionKey:"a".repeat(64),instances:[{id:"main",name:"OBS 1",exe,port:4455,password:"fixture",managed:true,initialized:true}]};});
/** 严格限定测试目录清理。 */
afterEach(async()=>{if(path.dirname(base)!==os.tmpdir()||!path.basename(base).startsWith("ln-migrate-"))throw new Error("Unsafe cleanup");await rm(base,{recursive:true,force:true});});
it("verifies the tree, relocates only media fields and preserves source and authorization",async()=>{const before=await readFile(scene,"utf8");const next=await copyDataLocation(settings,target,()=>{});const output=JSON.parse(await readFile(path.join(target,path.relative(source,scene)),"utf8"));expect(output.name).toBe(source);expect(output.sources[0].settings.local_file).toBe(path.join(await realpath(target),"media/main/videos/a.mp4"));expect(await readFile(scene,"utf8")).toBe(before);expect(await readFile(path.join(target,"state/youtube.enc"),"utf8")).toBe("synthetic-token-ciphertext");expect(next.instances[0].password).toBe("fixture");expect(next.rootId).not.toBe(settings.rootId);expect(next.instances[0].exe.startsWith(await realpath(target))).toBe(true);expect(JSON.parse(await readFile(path.join(target,MIGRATION_FILE),"utf8")).stage).toBe("ready-to-switch");});
it("detects destination corruption and retains a failed transaction record",async()=>{let corruption:Promise<void>|undefined;await expect(copyDataLocation(settings,target,async stage=>{if(stage.includes("逐文件")){corruption=writeFile(path.join(target,"state/youtube.enc"),"tampered");await corruption;}})).rejects.toThrow("校验");await corruption;expect(settings.dataRoot).toBe(source);expect(await readFile(path.join(source,"state/youtube.enc"),"utf8")).toBe("synthetic-token-ciphertext");expect(JSON.parse(await readFile(path.join(target,MIGRATION_FILE),"utf8")).stage).toBe("failed");});
it("refuses source links before copying",async()=>{await symlink(path.join(source,"state"),path.join(source,"alias"),process.platform==="win32"?"junction":"dir");await expect(copyDataLocation(settings,target,()=>{})).rejects.toThrow("链接");});
it("relocates candidates and archives but keeps external executables",async()=>{settings.candidates=[{...settings.instances[0],id:"candidate",initialized:false}];settings.archivedCandidates=[{...settings.instances[0],id:"archive",initialized:false}];const external=path.join(base,"external/bin/64bit/obs64.exe");settings.instances.push({...settings.instances[0],id:"external",managed:false,exe:external});const next=await copyDataLocation(settings,target,()=>{});expect(next.candidates![0].exe.startsWith(await realpath(target))).toBe(true);expect(next.archivedCandidates![0].exe.startsWith(await realpath(target))).toBe(true);expect(next.instances[1].exe).toBe(external);});
it("refuses external OBS scene references into the old root",async()=>{const external=path.join(base,"external/bin/64bit/obs64.exe");const scenes=path.join(base,"external/config/obs-studio/basic/scenes");await mkdir(scenes,{recursive:true});await writeFile(path.join(scenes,"scene.json"),await readFile(scene));settings.instances.push({...settings.instances[0],id:"external",managed:false,exe:external});await expect(copyDataLocation(settings,target,()=>{})).rejects.toThrow("手动 OBS 的场景");});

/** Windows runner 的 TEMP 可能是短路径；exe 已展开时也要定位到同一个源根。 */
it("relocates canonical managed executables from an aliased configured root",async()=>{
 settings.instances[0].exe=await realpath(settings.instances[0].exe);
 const next=await copyDataLocation(settings,target,()=>{});
 expect(next.instances[0].exe).toBe(path.join(await realpath(target),"obs/main/bin/64bit/obs64.exe"));
});
it("rejects a canonical external executable located inside an aliased source root",async()=>{
 settings.instances[0].exe=await realpath(settings.instances[0].exe);settings.instances[0].managed=false;
 await expect(copyDataLocation(settings,target,()=>{})).rejects.toThrow("手动 OBS 位于原数据根目录内");
 expect(await readFile(scene,"utf8")).toContain("local_file");
});
