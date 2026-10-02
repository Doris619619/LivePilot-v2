/** 复制校验与素材重定位回归；中断不切换、旧文件始终保留。 */
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath,stat,utimes } from "node:fs/promises";
import path from "node:path";import os from "node:os";
import {beforeEach,afterEach,it,expect} from "vitest";
import {copyDataLocation,MIGRATION_FILE} from "../electron/data-location";
import {claimRoot} from "../electron/data-root";
import type {Settings} from "../electron/settings";
import { restoreWindowsFileTimes } from "../electron/windows-file-times";
import { ensurePublishingRoot, hashPackageFile, packageDigest, scanPublishingPackages, validatePackage } from "../src/core/publishing/packages";
import { preparePackageUpload, validatePreparedUpload, type PackageUpload } from "../src/core/publishing/render";
let base:string;let source:string;let target:string;let settings:Settings;let scene:string;
const nativeMigrationTimeout = process.platform === "win32" ? 20_000 : 5_000;
const nativeCleanupTimeout = process.platform === "win32" ? 125_000 : 5_000;
let pendingMigrations: Promise<void>[] = [];
/** 保留每次本机迁移的结算，测试失败或超时后也必须先等子进程退出，再清理合成文件。 */
function trackMigration<T>(operation: Promise<T>): Promise<T> {
 const settled = operation.then(() => {}, () => {}); pendingMigrations.push(settled); return operation;
}
/** 仅追踪本用例创建的迁移，保持原始成功和拒绝结果供断言。 */
function migrate(...args: Parameters<typeof copyDataLocation>) { return trackMigration(copyDataLocation(...args)); }
/** 构造真实目录层级和合成授权，不启动 OBS。 */
beforeEach(async()=>{pendingMigrations=[];base=await mkdtemp(path.join(os.tmpdir(),"ln-migrate-"));source=path.join(base,"旧目录");target=path.join(base,"新目录");const marker=await claimRoot(source);const exe=path.join(source,"obs/main/bin/64bit/obs64.exe");await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,"fixture");scene=path.join(source,"obs/main/config/obs-studio/basic/scenes/LiveNest.json");await mkdir(path.dirname(scene),{recursive:true});await writeFile(scene,JSON.stringify({name:source,sources:[{settings:{local_file:path.join(source,"media/main/videos/a.mp4")}}]}));await mkdir(path.join(source,"state"));await writeFile(path.join(source,"state/youtube.enc"),"synthetic-token-ciphertext");settings={rootId:marker.id,dataRoot:source,encryptionKey:"a".repeat(64),instances:[{id:"main",name:"OBS 1",exe,port:4455,password:"fixture",managed:true,initialized:true}]};});
/** 等待本用例任务结算后严格限定目录清理；120s native 上限结束前不与子进程竞争删除。 */
afterEach(async()=>{const cleanupBase=base;const pending=pendingMigrations.slice();if(path.dirname(cleanupBase)!==os.tmpdir()||!path.basename(cleanupBase).startsWith("ln-migrate-"))throw new Error("Unsafe cleanup");await Promise.all(pending);await rm(cleanupBase,{recursive:true,force:true});},nativeCleanupTimeout);
/** CI 首次真实 PowerShell 启动可超过5s；仅为涉及 native 复制的用例设置有限20s。 */
it("verifies the tree, relocates only media fields and preserves source and authorization",async()=>{const before=await readFile(scene,"utf8");const next=await migrate(settings,target,()=>{});const output=JSON.parse(await readFile(path.join(target,path.relative(source,scene)),"utf8"));expect(output.name).toBe(source);expect(output.sources[0].settings.local_file).toBe(path.join(await realpath(target),"media/main/videos/a.mp4"));expect(await readFile(scene,"utf8")).toBe(before);expect(await readFile(path.join(target,"state/youtube.enc"),"utf8")).toBe("synthetic-token-ciphertext");expect(next.instances[0].password).toBe("fixture");expect(next.rootId).not.toBe(settings.rootId);expect(next.instances[0].exe.startsWith(await realpath(target))).toBe(true);expect(JSON.parse(await readFile(path.join(target,MIGRATION_FILE),"utf8")).stage).toBe("ready-to-switch");},nativeMigrationTimeout);
it("detects destination corruption and retains a failed transaction record",async()=>{let corruption:Promise<void>|undefined;await expect(migrate(settings,target,async stage=>{if(stage.includes("逐文件")){corruption=writeFile(path.join(target,"state/youtube.enc"),"tampered");await corruption;}})).rejects.toThrow("校验");await corruption;expect(settings.dataRoot).toBe(source);expect(await readFile(path.join(source,"state/youtube.enc"),"utf8")).toBe("synthetic-token-ciphertext");expect(JSON.parse(await readFile(path.join(target,MIGRATION_FILE),"utf8")).stage).toBe("failed");},nativeMigrationTimeout);
it("refuses source links before copying",async()=>{await symlink(path.join(source,"state"),path.join(source,"alias"),process.platform==="win32"?"junction":"dir");await expect(migrate(settings,target,()=>{})).rejects.toThrow("链接");});
it("relocates candidates and archives but keeps external executables",async()=>{settings.candidates=[{...settings.instances[0],id:"candidate",initialized:false}];settings.archivedCandidates=[{...settings.instances[0],id:"archive",initialized:false}];const external=path.join(base,"external/bin/64bit/obs64.exe");settings.instances.push({...settings.instances[0],id:"external",managed:false,exe:external});const next=await migrate(settings,target,()=>{});expect(next.candidates![0].exe.startsWith(await realpath(target))).toBe(true);expect(next.archivedCandidates![0].exe.startsWith(await realpath(target))).toBe(true);expect(next.instances[1].exe).toBe(external);},nativeMigrationTimeout);
it("refuses external OBS scene references into the old root",async()=>{const external=path.join(base,"external/bin/64bit/obs64.exe");const scenes=path.join(base,"external/config/obs-studio/basic/scenes");await mkdir(scenes,{recursive:true});await writeFile(path.join(scenes,"scene.json"),await readFile(scene));settings.instances.push({...settings.instances[0],id:"external",managed:false,exe:external});await expect(migrate(settings,target,()=>{})).rejects.toThrow("手动 OBS 的场景");});

/** Windows runner 的 TEMP 可能是短路径；exe 已展开时也要定位到同一个源根。 */
it("relocates canonical managed executables from an aliased configured root",async()=>{
 settings.instances[0].exe=await realpath(settings.instances[0].exe);
 const next=await migrate(settings,target,()=>{});
 expect(next.instances[0].exe).toBe(path.join(await realpath(target),"obs/main/bin/64bit/obs64.exe"));
},nativeMigrationTimeout);
it("rejects a canonical external executable located inside an aliased source root",async()=>{
 settings.instances[0].exe=await realpath(settings.instances[0].exe);settings.instances[0].managed=false;
 await expect(migrate(settings,target,()=>{})).rejects.toThrow("手动 OBS 位于原数据根目录内");
 expect(await readFile(scene,"utf8")).toContain("local_file");
});

/** NTFS 100ns 时间必须跨实际复制保持；同时验证原视频和持久生成输出的恢复快照。 */
it.runIf(process.platform === "win32")("preserves exact NTFS timestamps and both prepared upload checkpoints after migration", async () => {
  const publishing = path.join(source, "Publishing"); const batchName = "批次' $(literal)";
  await ensurePublishingRoot(publishing);
  for (const name of ["001", "002"]) {
    const directory = path.join(publishing, "Inbox", batchName, name);
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "video.mp4"), "synthetic-video");
    await utimes(path.join(directory, "video.mp4"), 1700000000.1234567, 1700000000.1234567);
  }
  const musicFile = path.join(publishing, "Inbox", batchName, "002", "music.mp3");
  await writeFile(musicFile, "synthetic-music"); await utimes(musicFile, 1700000000.2345678, 1700000000.2345678);
  const packages = (await scanPublishingPackages(publishing)).batches[0].packages;
  const original = await preparePackageUpload(publishing, packages[0]);
  expect(original.asset.mtimeMs % 1).not.toBe(0);
  const pkg = packages[1]; const segments = ["Working", batchName, pkg.name, pkg.version, "output.mp4"];
  const output = path.join(publishing, ...segments); await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, "synthetic-prepared-output"); await utimes(output, 1700000000.3456789, 1700000000.3456789);
  const info = await stat(output); const sha256 = await hashPackageFile(output);
  const generated: PackageUpload = { relativePath: segments.join("/"), sha256, asset: { id: packageDigest(segments), filename: "output.mp4", size: info.size, mtimeMs: info.mtimeMs, version: packageDigest([segments, info.size, info.mtimeMs]), sha256, hashState: "verified" } };
  const video = path.join(publishing, "Inbox", batchName, pkg.name, "video.mp4");
  await writeFile(path.join(path.dirname(output), "render.json"), JSON.stringify({ version: 1, recipe: 1, packageVersion: pkg.version, state: "ready", sources: { video: await hashPackageFile(video), music: await hashPackageFile(musicFile) }, upload: generated, duration: 10 }));
  await validatePreparedUpload(publishing, generated, pkg);
  const originalTimestamp = (await stat(path.join(publishing, original.relativePath), { bigint: true })).mtimeNs;
  const generatedTimestamp = (await stat(output, { bigint: true })).mtimeNs;
  const next = await migrate(settings, target, () => {}); const relocated = path.join(next.dataRoot, "Publishing");
  expect((await stat(path.join(relocated, original.relativePath), { bigint: true })).mtimeNs).toBe(originalTimestamp);
  expect((await stat(path.join(relocated, generated.relativePath), { bigint: true })).mtimeNs).toBe(generatedTimestamp);
  await validatePackage(relocated, packages[0]); await validatePackage(relocated, pkg);
  expect((await validatePreparedUpload(relocated, original, packages[0])).sha256).toBe(original.sha256);
  expect((await validatePreparedUpload(relocated, generated, pkg)).sha256).toBe(generated.sha256);
  expect((await scanPublishingPackages(relocated)).batches[0].packages).toEqual(packages);
}, nativeMigrationTimeout);

/** 仅改变源时间也必须拒绝提交，不能用复制阶段的新时间掩盖已确认版本变化。 */
it.runIf(process.platform === "win32")("refuses a source timestamp change during copying and preserves the original root", async () => {
  const file = path.join(source, "state", "youtube.enc"); const before = (await stat(file)).mtimeMs;
  await expect(migrate(settings, target, async stage => {
    if (stage.includes("正在复制")) await utimes(file, before / 1000 + 2, before / 1000 + 2);
  })).rejects.toThrow("时间校验失败或源文件已改变");
  expect(settings.dataRoot).toBe(source); expect(await readFile(file, "utf8")).toBe("synthetic-token-ciphertext");
  expect(JSON.parse(await readFile(path.join(target, MIGRATION_FILE), "utf8")).stage).toBe("failed");
}, nativeMigrationTimeout);

/** 时间 helper 只接受已验证目录内的普通相对文件，不能越界或跟随新换入的 junction。 */
it.runIf(process.platform === "win32")("rejects escaping or linked paths before restoring file timestamps", async () => {
  await mkdir(target); const original = path.join(source, "state", "youtube.enc");
  const mtimeNs = (await stat(original, { bigint: true })).mtimeNs.toString();
  await expect(trackMigration(restoreWindowsFileTimes(source, target, [{ relative: "../state/youtube.enc", mtimeNs }]))).rejects.toThrow("时间记录无效");
  await symlink(path.join(source, "state"), path.join(target, "state"), "junction");
  await expect(trackMigration(restoreWindowsFileTimes(source, target, [{ relative: "state/youtube.enc", mtimeNs }]))).rejects.toThrow("时间校验失败");
  expect((await stat(original, { bigint: true })).mtimeNs.toString()).toBe(mtimeNs);
}, nativeMigrationTimeout);
