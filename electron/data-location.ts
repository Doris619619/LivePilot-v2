/** 数据位置选择与保留原目录的迁移；程序安装目录和用户数据分开。 */
import { mkdir, writeFile, unlink, readdir, cp, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "./settings";
/** 验证目录可写，探针仅删除本次创建的随机文件。 */
export async function writableDirectory(root:string){await mkdir(root,{recursive:true});const file=path.join(root,".livenest-probe-"+randomUUID());await writeFile(file,"ok",{flag:"wx"});await unlink(file);}
/** 新安装优先 D 盘，失败明确告知回退；已有配置不调用此函数。 */
export async function defaultDataLocation(fallback:string){try{await realpath("D:\\");const root="D:\\LiveNest";await writableDirectory(root);return {dataRoot:root};}catch{await writableDirectory(fallback);return {dataRoot:fallback,dataNotice:"D 盘不存在或不可写，已选择当前用户目录。可在准备 OBS 前选择其他位置。"};}}
/** 复制到空目录后才返回新配置；拒绝嵌套、联接和覆盖，原数据保留。 */
export async function copyDataLocation(settings:Settings,target:string,progress:(stage:string)=>void){
 await writableDirectory(target);const source=await realpath(settings.dataRoot);const destination=await realpath(target);
 const rel=path.relative(source,destination);const back=path.relative(destination,source);
 if(!rel||(!rel.startsWith("..")&&!path.isAbsolute(rel))||(!back.startsWith("..")&&!path.isAbsolute(back)))throw new Error("请选择原目录之外的独立空文件夹。");
 if((await readdir(destination)).length)throw new Error("目标文件夹不是空目录，请选择新的文件夹；没有覆盖任何文件。");
 progress("正在复制 OBS、素材与授权，原目录保留");
 for(const name of await readdir(source)) await cp(path.join(source,name),path.join(destination,name),{recursive:true,force:false,errorOnExist:true,filter:async file=>{if((await lstat(file)).isSymbolicLink())throw new Error("数据目录中存在链接，无法安全自动迁移；原数据保留。");return true;}});
 /** 只更新托管实例的内部程序路径，外部手动 OBS 保持原路径。 */
 const relocate=(items:Settings["instances"]|undefined)=>items?.map(i=>({...i,exe:i.managed?path.join(destination,path.relative(source,i.exe)):i.exe}));
 return {...settings,dataRoot:destination,dataNotice:"数据已复制到新位置，旧目录保留，请确认使用正常后再自行整理。",instances:relocate(settings.instances)!,candidates:relocate(settings.candidates),archivedCandidates:relocate(settings.archivedCandidates)};
}
