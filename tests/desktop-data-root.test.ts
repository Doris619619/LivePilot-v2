/** 根归属与配置定位回归，所有文件及密钥均为临时合成数据。 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { claimRoot, readRoot, checkRootPath, hasData, ROOT_MARKER } from "../electron/data-root";
import { SettingsStore } from "../electron/settings";
import { Store } from "../src/core/storage";
const f=vi.hoisted(()=>({bootstrap:"", protect:vi.fn()}));
vi.mock("electron",()=>({app:{isPackaged:false,getPath:()=>f.bootstrap},safeStorage:{decryptString:()=>{throw new Error("unsupported fixture");}}}));
vi.mock("../electron/windows-credentials",()=>({protectWindows:f.protect}));
let base:string; let target:string;
/** 每例拥有自己的定位记录及数据根，禁止读取真实 AppData。 */
beforeEach(async()=>{base=await mkdtemp(path.join(os.tmpdir(),"ln-root-"));target=path.join(base,"直播 空格","LiveNest");f.bootstrap=path.join(base,"bootstrap");f.protect.mockImplementation(async(bytes:Buffer)=>bytes);vi.stubEnv("LIVENEST_TEST_DATA","");});
/** 仅清理创建的测试根。 */
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();if(path.dirname(base)!==os.tmpdir()||!path.basename(base).startsWith("ln-root-"))throw new Error("Unsafe cleanup");await rm(base,{recursive:true,force:true});});
it("claims a Chinese path once and preserves a stable root ID",async()=>{const first=await claimRoot(target);expect(await claimRoot(target)).toEqual(first);expect(await readRoot(target)).toEqual(first);});
it("refuses unknown nonempty and corrupt owned directories without changing bytes",async()=>{await mkdir(target,{recursive:true});await writeFile(path.join(target,"user.txt"),"keep");await expect(claimRoot(target)).rejects.toThrow("没有覆盖");expect(await readFile(path.join(target,"user.txt"),"utf8")).toBe("keep");await writeFile(path.join(target,ROOT_MARKER),"{}");await expect(claimRoot(target)).rejects.toThrow("标记无效");});
it("rejects equal, ancestor, descendant and junction installation overlap",async()=>{const install=path.join(base,"program");await mkdir(install);for(const candidate of [install,path.join(install,"LiveNest"),base])await expect(checkRootPath(candidate,install)).rejects.toThrow("相互包含");const alias=path.join(base,"alias");await symlink(install,alias,process.platform==="win32"?"junction":"dir");await expect(checkRootPath(path.join(alias,"LiveNest"))).rejects.toThrow("链接");});
it("does not create a default directory before an explicit selection",async()=>{const settings=await new SettingsStore().read();expect(settings.dataRoot).toBe("");expect(await readdir(base)).toEqual([]);});
it("stores encrypted settings only in the root and a secret-free locator in AppData",async()=>{const store=new SettingsStore();const first=await store.select(target);const locator=await readFile(path.join(f.bootstrap,"data-location.json"),"utf8");expect(locator).not.toContain(first.encryptionKey);expect(await readdir(f.bootstrap)).toEqual(["data-location.json"]);expect(await store.read()).toEqual(first);const encrypted=JSON.parse(await readFile(path.join(target,"state/desktop/settings.json"),"utf8"));expect(encrypted).toMatch(/^dpapi:/);expect(await hasData(first)).toBe(false);await writeFile(path.join(target,"leftover.bin"),"business");expect(await hasData(first)).toBe(true);});
it("fails closed when the selected disk disappears",async()=>{const store=new SettingsStore();await store.select(target);await import("node:fs/promises").then(fs=>fs.rename(target,target+"-offline"));await expect(store.read()).rejects.toThrow("没有创建新身份");expect(await readdir(path.dirname(target))).toEqual(["LiveNest-offline"]);});
it("relocates only the verified original root after a disk path change without replacing identity", async () => {
 const store=new SettingsStore();const original=await store.select(target);original.identity={agentId:"fixture",token:"synthetic",origin:"https://example.invalid"};original.instances=[{id:"main",name:"Main",managed:true,initialized:true,exe:path.join(target,"obs/main/bin/64bit/obs64.exe"),port:4455,password:"fixture"}];await store.write(original);
 const moved=target+"-moved";await import("node:fs/promises").then(fs=>fs.rename(target,moved));
 // Windows 临时目录可能使用 8.3 短名；恢复结果应始终基于已解析的真实目标根。
 const canonicalMoved=await realpath(moved);
 const before=await readFile(path.join(f.bootstrap,"data-location.json"),"utf8");const inspected=await store.inspectRecovery(moved);expect(inspected.identity).toEqual(original.identity);expect(inspected.encryptionKey).toBe(original.encryptionKey);expect(inspected.instances[0].exe).toBe(path.join(canonicalMoved,"obs/main/bin/64bit/obs64.exe"));expect(await readFile(path.join(f.bootstrap,"data-location.json"),"utf8")).toBe(before);
 await store.restoreLocation(moved);expect((await store.read()).identity).toEqual(original.identity);expect((await store.read()).dataRoot).toBe(canonicalMoved);
});
it("rejects an unrelated root and an available original rather than selecting a stale copy", async () => {
 const store=new SettingsStore();await store.select(target);const foreign=path.join(base,"foreign");await claimRoot(foreign);
 await expect(store.inspectRecovery(foreign)).rejects.toThrow("原数据位置仍存在");await import("node:fs/promises").then(fs=>fs.rename(target,target+"-offline"));await expect(store.inspectRecovery(foreign)).rejects.toThrow("不是原 LiveNest 数据");
});
/** 正确原根已改名；只替代 DPAPI，路径、原子文件和恢复提交记录均为真实临时文件。 */
async function movedRecoveryFixture() {
 const store=new SettingsStore(), original=await store.select(target); original.identity={agentId:"original",origin:"https://example.invalid",token:"synthetic-original-token"};
 original.instances=[{id:"main",name:"Main",managed:true,exe:path.join(target,"obs/main/bin/64bit/obs64.exe"),port:4455,password:"synthetic-password",initialized:true}];await store.write(original);
 await writeFile(path.join(target,"preserve.txt"),"original bytes"); const moved=target+"-moved";await rename(target,moved); return {store,original,moved};
}
it.each(["journal", "settings", "locator"])("reenters the same relocation after the %s commit fails and the app restarts",async stage=>{
 const {store,original,moved}=await movedRecoveryFixture();const method=Store.prototype.write;
 const failed=stage==="journal"?"data-recovery.json":stage==="settings"?"settings.json":"data-location.json";
 const spy=vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name===failed)throw new Error("synthetic relocation commit failure");return method.call(this,name,value);});
 await expect(store.restoreLocation(moved)).rejects.toThrow("synthetic relocation commit failure");spy.mockRestore();
 if(stage!=="journal"){const journal=await readFile(path.join(f.bootstrap,"data-recovery.json"),"utf8");expect(journal).not.toContain(original.encryptionKey);expect(journal).not.toContain(original.identity!.token);}
 const restarted=new SettingsStore();await restarted.restoreLocation(moved);const recovered=await restarted.read();
 expect(recovered.identity).toEqual(original.identity);expect(recovered.encryptionKey).toBe(original.encryptionKey);expect(recovered.dataRoot).toBe(await realpath(moved));expect(await readFile(path.join(moved,"preserve.txt"),"utf8")).toBe("original bytes");
 expect(await new Store(f.bootstrap).read("data-recovery.json")).toBeNull();
});
it("can complete the journaled relocation after the original directory is moved back",async()=>{
 const {store,original,moved}=await movedRecoveryFixture();const method=Store.prototype.write;
 const spy=vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name==="data-location.json")throw new Error("locator failed");return method.call(this,name,value);});
 await expect(store.restoreLocation(moved)).rejects.toThrow("locator failed");spy.mockRestore();await rename(moved,target);
 const restarted=new SettingsStore();await restarted.restoreLocation(target);expect((await restarted.read()).identity).toEqual(original.identity);expect((await restarted.read()).instances[0].exe).toBe(path.join(await realpath(target),"obs/main/bin/64bit/obs64.exe"));
});
/** 第二次恢复自身失败也必须保留当前密文的解释链；回搬同一根到A或B均不替换身份。 */
it.each((["journal", "settings", "locator", "cleanup"] as const).flatMap(stage=>(["original", "moved"] as const).map(destination=>[stage,destination] as const)))("reenters a moved-back root after a second %s failure at %s without losing committed-location evidence",async(stage,destination)=>{
 const {store,original,moved}=await movedRecoveryFixture();const method=Store.prototype.write;const committedRoot=await realpath(moved);
 const first=vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name==="data-location.json")throw new Error("first locator failure");return method.call(this,name,value);});
 await expect(store.restoreLocation(moved)).rejects.toThrow("first locator failure");first.mockRestore();await rename(moved,target);const retryTarget=await realpath(target);
 const failed=stage==="journal"?"data-recovery.json":stage==="settings"?"settings.json":"data-location.json";
 const second=stage==="cleanup"?vi.spyOn(Store.prototype,"remove").mockRejectedValueOnce(new Error("second recovery failure")):vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name===failed)throw new Error("second recovery failure");return method.call(this,name,value);});
 await expect(new SettingsStore().restoreLocation(target)).rejects.toThrow("second recovery failure");second.mockRestore();
 if(destination==="moved")await rename(target,moved);const selected=destination==="moved"?moved:target;
 const journal=await readFile(path.join(f.bootstrap,"data-recovery.json"),"utf8");expect(journal).not.toContain(original.encryptionKey);expect(journal).not.toContain(original.identity!.token);
 if(stage==="settings")expect(JSON.parse(journal)).toMatchObject({version:2,from:target,to:retryTarget,committed:committedRoot});
 const restarted=new SettingsStore();await restarted.restoreLocation(selected);const recovered=await restarted.read();
 expect(recovered.identity).toEqual(original.identity);expect(recovered.encryptionKey).toBe(original.encryptionKey);expect(recovered.dataRoot).toBe(await realpath(selected));expect(recovered.instances[0].exe).toBe(path.join(await realpath(selected),"obs/main/bin/64bit/obs64.exe"));expect(await readFile(path.join(selected,"preserve.txt"),"utf8")).toBe("original bytes");expect(await new Store(f.bootstrap).read("data-recovery.json")).toBeNull();
});
/** 升级不要求删除旧提交记录；v1的to继续解释已提交到新位置的同一原身份密文。 */
it("resumes a legacy v1 recovery journal after a locator failure",async()=>{
 const {store,original,moved}=await movedRecoveryFixture();const method=Store.prototype.write;
 const spy=vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name==="data-location.json")throw new Error("locator failed");return method.call(this,name,value);});await expect(store.restoreLocation(moved)).rejects.toThrow("locator failed");spy.mockRestore();
 const locator=new Store(f.bootstrap),journal=(await locator.read<Record<string,unknown>>("data-recovery.json"))!;delete journal.committed;await locator.write("data-recovery.json",{...journal,version:1});
 const restarted=new SettingsStore();await restarted.restoreLocation(moved);expect((await restarted.read()).identity).toEqual(original.identity);expect(await locator.read("data-recovery.json")).toBeNull();
});
it.each(["root", "identity", "live-lock"])("does not let a relocation journal bypass changed %s evidence",async kind=>{
 const {store,moved}=await movedRecoveryFixture();const method=Store.prototype.write;
 const spy=vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name==="data-location.json")throw new Error("locator failed");return method.call(this,name,value);});await expect(store.restoreLocation(moved)).rejects.toThrow();spy.mockRestore();
 const locator=new Store(f.bootstrap);const journal=await locator.read<Record<string,unknown>>("data-recovery.json");
 if(kind==="root")await locator.write("data-recovery.json",{...journal,rootId:"different-root"});
 if(kind==="identity")await locator.write("data-recovery.json",{...journal,identityDigest:"0".repeat(64)});
 if(kind==="live-lock")await writeFile(path.join(moved,"state/host.lock"),String(process.pid));
 await expect(new SettingsStore().inspectRecovery(moved)).rejects.toThrow();
 expect((await locator.read<{dataRoot:string}>("data-location.json"))?.dataRoot).toBe(target);expect(await readFile(path.join(moved,"preserve.txt"),"utf8")).toBe("original bytes");
});
it("preserves legacy encrypted identity and commits its verified in-root copy",async()=>{await mkdir(target,{recursive:true});const settings={dataRoot:target,instances:[],encryptionKey:"a".repeat(64),identity:{agentId:"fixture",token:"synthetic",origin:"https://example.invalid"}};const original="dpapi:"+Buffer.from(JSON.stringify(settings)).toString("base64");await new Store(f.bootstrap).write("settings.json",original);const next=await new SettingsStore().read();expect(next.identity).toEqual(settings.identity);expect(next.rootId).toBeTruthy();expect(await new Store(f.bootstrap).read("settings.json")).toBe(original);expect(await new SettingsStore().read()).toEqual(next);});
it("does not publish a new locator when encrypted writing fails",async()=>{f.protect.mockRejectedValue(new Error("fixture encryption failure"));await expect(new SettingsStore().select(target)).rejects.toThrow();expect(await new Store(f.bootstrap).read("data-location.json")).toBeNull();});
it("keeps the old location when committing the new locator fails",async()=>{const store=new SettingsStore();const original=await store.select(target);const method=Store.prototype.write;vi.spyOn(Store.prototype,"write").mockImplementation(async function(this:Store,name,value){if(name==="data-location.json")throw new Error("locator unavailable");return method.call(this,name,value);});await expect(store.select(path.join(base,"other"))).rejects.toThrow("locator unavailable");expect((await store.read()).rootId).toBe(original.rootId);});
it("refuses missing, foreign or undecryptable settings without issuing a fresh identity",async()=>{const store=new SettingsStore();await store.select(target);await writeFile(path.join(target,"state/desktop/settings.json"),JSON.stringify("dpapi:"+Buffer.from("invalid").toString("base64")));await expect(store.read()).rejects.toThrow("无法解密");await expect(store.select(target)).rejects.toThrow("无法解密");});
it("does not follow a replaced state directory junction",async()=>{await claimRoot(target);const elsewhere=path.join(base,"elsewhere");await mkdir(elsewhere);await symlink(elsewhere,path.join(target,"state"),process.platform==="win32"?"junction":"dir");await expect(new SettingsStore().select(target)).rejects.toThrow("链接");expect(await readdir(elsewhere)).toEqual([]);});

it("does not overwrite newer root settings with the retained legacy backup after locator loss",async()=>{
 const store=new SettingsStore();const current=await store.select(target);current.instances=[{id:"main",name:"New saved name",managed:true,exe:path.join(target,"obs/main/bin/64bit/obs64.exe"),port:4455,password:"fixture",initialized:true}];await store.write(current);
 const legacy={...current,instances:[],rootId:undefined};await new Store(f.bootstrap).write("settings.json","dpapi:"+Buffer.from(JSON.stringify(legacy)).toString("base64"));await new Store(f.bootstrap).remove("data-location.json");
 const recovered=await store.read();expect(recovered.instances[0].name).toBe("New saved name");expect(recovered.encryptionKey).toBe(current.encryptionKey);
});

/** 旧版可能先保存候选、尚未解压就退出；不能把缺失的候选目录当作外部文件。 */
it("recovers an unextracted legacy candidate but rejects ownerless existing files",async()=>{
 await mkdir(target,{recursive:true});
 const candidate={id:"main",name:"OBS 1",managed:true,exe:path.join(target,"obs/main/bin/64bit/obs64.exe"),port:4455,password:"fixture-only",initialized:false};
 const settings={dataRoot:target,instances:[],candidates:[candidate],encryptionKey:"a".repeat(64)};
 await new Store(f.bootstrap).write("settings.json","dpapi:"+Buffer.from(JSON.stringify(settings)).toString("base64"));
 const next=await new SettingsStore().read();expect(next.candidates).toEqual([candidate]);
 await new Store(f.bootstrap).remove("data-location.json");await new Store(target).remove(ROOT_MARKER);
 const obs=path.join(target,"obs/main");await mkdir(obs,{recursive:true});await writeFile(path.join(obs,"user.txt"),"keep");
 await expect(new SettingsStore().read()).rejects.toThrow();expect(await readFile(path.join(obs,"user.txt"),"utf8")).toBe("keep");
});

/** 合法 JSON 空值也是损坏配置，绝不能与文件不存在混淆并重置身份。 */
it.each([null, "", false])("rejects an existing invalid locator value %j",async value=>{
 await new Store(f.bootstrap).write("data-location.json",value);
 await expect(new SettingsStore().read()).rejects.toThrow();
 expect(await new Store(f.bootstrap).read("data-location.json")).toEqual(value);
});
it.each([null, "", false])("preserves existing invalid encrypted settings %j without generating an identity",async value=>{
 const store=new SettingsStore();await store.select(target);
 const config=new Store(path.join(target,"state/desktop"));await config.write("settings.json",value);
 await expect(store.select(target)).rejects.toThrow();
 expect(await config.read("settings.json")).toEqual(value);
});
it("rejects an explicitly empty legacy configuration",async()=>{
 await new Store(f.bootstrap).write("settings.json",null);
 await expect(new SettingsStore().read()).rejects.toThrow();
 expect(await new Store(f.bootstrap).read("data-location.json")).toBeNull();
});

/** 配置可能保留旧 8.3 拼写，重新选择长路径时仍必须识别为同一份身份。 */
it("restores the same encrypted identity through its canonical root path",async()=>{
 const store=new SettingsStore();const first=await store.select(target);
 const restored=await store.select(await realpath(target));
 expect(restored.rootId).toBe(first.rootId);expect(restored.encryptionKey).toBe(first.encryptionKey);
});
