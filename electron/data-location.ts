/** 数据复制事务：校验后切换、只修正托管路径、源目录始终保留。 */
import { AppError } from "../src/core/errors";
import { mkdir, writeFile, unlink, readdir, cp, lstat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Settings } from "./settings";
import { checkRootPath, claimRoot, readRoot, ROOT_MARKER, within, ordinaryEntry } from "./data-root";
import { Store } from "../src/core/storage";
import { restoreWindowsFileTimes } from "./windows-file-times";
export const MIGRATION_FILE = ".livenest-migration.json";
/** 验证可写，探针只删除本次随机文件。 */
export async function writableDirectory(root: string) { await mkdir(root, {recursive:true}); const probe=path.join(root,".livenest-probe-"+randomUUID()); await writeFile(probe,"ok",{flag:"wx"}); await unlink(probe); }
/** 流式散列适用于大视频，不把整份素材加载到内存。 */
async function checksum(file: string) { const hash=createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
/** 不跟随目录链接；列举长度和摘要，Windows 精确时间参与复制与源变更校验。 */
async function manifest(root: string) {
  const files: Record<string, {size:number; sha256:string; mtimeNs?:string}> = {};
  const dirs: string[] = [];
  /** 深度检查每个目录项；排除仅属于本次事务的根标记和日志。 */
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const file=path.join(dir,name); const relative=path.relative(root,file);
      if (relative===ROOT_MARKER || relative===MIGRATION_FILE) continue;
      const info=await lstat(file);
      if(info.isSymbolicLink() || (!info.isFile()&&!info.isDirectory())) throw new AppError("DATA", "数据目录中存在链接或特殊文件，无法安全迁移；原数据保留。");
      if(info.isDirectory()) { dirs.push(relative); await walk(file); }
      else files[relative]={size:info.size,sha256:await checksum(file),...(process.platform==="win32"?{mtimeNs:(await lstat(file,{bigint:true})).mtimeNs.toString()}:{})};
    }
  }
  await walk(root); return { files, dirs: dirs.sort() };
}
/** 限定 OBS 场景的已知本地路径字段，绝不替换频道名、密钥或任意字符串。 */
async function relocateScene(value: unknown, source: string, target: string, field = ""): Promise<unknown> {
  if (typeof value === "string" && ["local_file", "file", "filename", "path"].includes(field) && path.isAbsolute(value)) {
    // 数据根只允许本机磁盘；外部网络素材保持原地址。
    if (process.platform === "win32" && value.startsWith("\\\\")) return value;
    const canonical = await ordinaryEntry(value);
    if (within(source, canonical)) return path.join(target, path.relative(source, canonical));
    return value;
  }
  if(Array.isArray(value)) return Promise.all(value.map(item=>relocateScene(item,source,target,field)));
  if(value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key,item])=>[key,await relocateScene(item,source,target,key)])));
  return value;
}
/** 停止 Agent 之前检查目标边界与占用，不创建或覆盖目标内容。 */
export async function preflightDataLocation(settings: Settings,target: string,installation?: string) {
  const source=await checkRootPath(settings.dataRoot,installation);const destination=await checkRootPath(target,installation);
  if(settings.rootId && (await readRoot(source)).id!==settings.rootId)throw new AppError("DATA", "原数据目录归属已改变，未开始迁移。");
  if(within(source,destination)||within(destination,source))throw new AppError("DATA", "请选择原目录之外的独立空文件夹。");
  const names=await readdir(destination).catch(error=>{if(error.code==="ENOENT")return [];throw error;});
  if(names.length)throw new AppError("DATA", "目标文件夹不是空目录，请选择新的文件夹；失败副本和原数据均保留。");
  return {source,destination};
}
/** 迁移要求所有相关 OBS 关闭；调用方已取得维护并停止 Agent。 */
export async function copyDataLocation(settings: Settings, target: string, progress: (stage: string)=>void | Promise<void>, installation?: string): Promise<Settings> {
  const {source,destination}=await preflightDataLocation(settings,target,installation);
  await mkdir(destination,{recursive:true});
  if((await readdir(destination)).length) throw new AppError("DATA", "目标文件夹不是空目录，请选择新的文件夹；失败副本和原数据均保留。");
  const items=[...settings.instances,...(settings.candidates||[]),...(settings.archivedCandidates||[])];
  const canonicalExes = new Map(await Promise.all(items.map(async item => [item, await ordinaryEntry(item.exe)] as const)));
  // 外部 OBS 若自身位于根内，复制后无法保证它保持独立管理，必须先人工处理。
  for(const item of items.filter(i=>!i.managed)) {
    if(within(source,canonicalExes.get(item)!)) throw new AppError("DATA", "手动 OBS 位于原数据根目录内，请先处理外部 OBS 路径再迁移。");
    const sceneDir=path.resolve(item.exe,"../../../config/obs-studio/basic/scenes");
    for(const name of await readdir(sceneDir).catch(e=>{if(e.code==="ENOENT")return [];throw e;})) {
      if(!/\.json(?:\.bak)?$/i.test(name))continue;
      const scene=JSON.parse(await readFile(path.join(sceneDir,name),"utf8"));
      if(JSON.stringify(scene)!==JSON.stringify(await relocateScene(scene,source,destination)))throw new AppError("DATA", "手动 OBS 的场景引用原数据目录，请先在 OBS 调整素材引用再迁移。");
    }
  }
  await progress("正在校验源文件与磁盘空间");
  const before=await manifest(source);
  const fs=await import("node:fs/promises"); const disk=await fs.statfs(destination);
  const bytes=Object.values(before.files).reduce((sum,f)=>sum+f.size,0);
  if(disk.bavail*disk.bsize<bytes+512*1024**2)throw new AppError("DATA", "目标磁盘空间不足，原数据位置保持不变。");
  const marker=await claimRoot(destination,installation); const journal=new Store(destination);
  const record={version:1,source,destination,rootId:marker.id,stage:"copying",manifest:before};
  await journal.write(MIGRATION_FILE,record);
  try {
    await progress("正在复制 OBS、素材与授权，原目录保留");
    for(const name of await readdir(source)) {
      if(name===ROOT_MARKER || name===MIGRATION_FILE)continue;
      await cp(path.join(source,name),path.join(destination,name),{recursive:true,preserveTimestamps:true,force:false,errorOnExist:true,filter:async file=>{if((await lstat(file)).isSymbolicLink())throw new AppError("DATA", "数据目录含链接，复制已中止。");return true;}});
    }
    // Node cp 使用 Date 会舍入 NTFS 的小数毫秒；固定素材/最终文件快照需要精确保留。
    if(process.platform==="win32") await restoreWindowsFileTimes(source,destination,Object.entries(before.files).map(([relative,file])=>({relative,mtimeNs:file.mtimeNs!})));
    await progress("正在逐文件校验复制结果");
    if(JSON.stringify(before)!==JSON.stringify(await manifest(destination)) || JSON.stringify(before)!==JSON.stringify(await manifest(source)))throw new AppError("DATA", "复制校验失败或源文件发生变化，没有切换数据位置。");
    await journal.write(MIGRATION_FILE,{...record,stage:"verified"});
    /** 所有实例种类共享相同的路径迁移，外部 OBS 保留。 */
    const relocate=(list: Settings["instances"]|undefined)=>list?.map(item=>{
      if(!item.managed)return {...item};
      const canonical = canonicalExes.get(item)!;
      const relative=path.relative(source,canonical);
      if(!within(source,canonical))throw new AppError("DATA", "托管 OBS 不在原数据目录内，原配置保留。");
      return {...item,exe:path.join(destination,relative)};
    });
    for(const item of items.filter(i=>i.managed)) {
      const sceneDir=path.join(destination,path.relative(source,path.resolve(canonicalExes.get(item)!,"../../../config/obs-studio/basic/scenes")));
      if(!within(destination,sceneDir))throw new AppError("DATA", "托管 OBS 路径超出数据目录。");
      for(const name of await readdir(sceneDir).catch(e=>{if(e.code==="ENOENT")return [];throw e;})) {
        if(!/\.json(?:\.bak)?$/i.test(name))continue;
        const file=path.join(sceneDir,name); const original=JSON.parse(await readFile(file,"utf8"));
        const updated=await relocateScene(original,source,destination);
        if(JSON.stringify(updated)!==JSON.stringify(original)) { await writeFile(file,JSON.stringify(updated)); if(JSON.stringify(JSON.parse(await readFile(file,"utf8")))!==JSON.stringify(updated))throw new AppError("DATA", "素材路径写入校验失败。"); }
      }
    }
    await journal.write(MIGRATION_FILE,{...record,stage:"ready-to-switch"});
    return {...settings,rootId:marker.id,dataRoot:destination,dataNotice:"数据已复制到新位置，旧目录保留，请确认使用正常后再自行整理。",instances:relocate(settings.instances)!,candidates:relocate(settings.candidates),archivedCandidates:relocate(settings.archivedCandidates)};
  } catch(error) { await journal.write(MIGRATION_FILE,{...record,stage:"failed"}).catch(()=>{}); throw error; }
}
