/** LiveNest 根目录归属与路径边界；安装选择和迁移均不得接管未知目录。 */
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "./settings";
export const ROOT_MARKER = ".livenest-root.json";
export type RootMarker = { product: "LiveNest"; version: 1; id: string };
/** 包含相等边界，避免字符串前缀把 LiveNest2 当作 LiveNest 子目录。 */
export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
/** 解析不存在路径的最近祖先，同时拒绝 junction / symlink。 */
export async function ordinaryPath(value: string): Promise<string> {
  if (!value || !path.isAbsolute(value) || (process.platform === "win32" && value.startsWith("\\\\"))) throw new Error("请选择本机绝对路径。");
  const absolute = path.resolve(value); const parent = path.dirname(absolute);
  const canonicalParent = parent !== absolute ? await ordinaryPath(parent) : parent;
  try { const info = await lstat(absolute); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("数据位置不能包含文件或目录链接。"); return await realpath(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if(parent===absolute)throw new Error("目标数据盘不可用。"); return path.join(canonicalParent,path.basename(absolute)); }
}
/** 文件或目录路径统一展开短路径；不存在的叶子沿用已验证祖先，不跟随链接。 */
export async function ordinaryEntry(value: string): Promise<string> {
  const parent = await ordinaryPath(path.dirname(value));
  try {
    const info = await lstat(value);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("数据路径包含链接或特殊文件，无法安全处理。");
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(parent, path.basename(value));
  }
}
/** 写入之前检查真实安装路径，防止卸载误删业务目录。 */
export async function checkRootPath(target: string, installation?: string) {
  const root = await ordinaryPath(target);
  if (installation) {
    const installed = await ordinaryPath(installation);
    if (within(installed, root) || within(root, installed)) throw new Error("程序安装位置和 LiveNest 数据位置不能相同或相互包含，请选择其他文件夹。");
  }
  return root;
}
/** 标记损坏、缺失或版本不认识均拒绝写入，不能当作空目录。 */
export async function readRoot(root: string): Promise<RootMarker> {
  await ordinaryPath(root);
  const markerFile = path.join(root, ROOT_MARKER);
  if ((await lstat(markerFile)).isSymbolicLink()) throw new Error("LiveNest 根目录标记不能是链接。");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (marker?.product !== "LiveNest" || marker.version !== 1 || typeof marker.id !== "string" || !/^[a-f0-9-]{36}$/.test(marker.id)) throw new Error("LiveNest 数据目录标记无效，请保留文件并选择其他位置。");
  return marker;
}
/** 只创建空目录；已有目录必须携带有效标记，不覆盖用户文件。 */
export async function claimRoot(target: string, installation?: string): Promise<RootMarker> {
  const root = await checkRootPath(target, installation);
  await mkdir(root, { recursive: true });
  const files = await readdir(root);
  if (files.includes(ROOT_MARKER)) return readRoot(root);
  if (files.length) throw new Error("目标 LiveNest 文件夹已有文件且不是有效 LiveNest 数据目录，没有覆盖任何文件。");
  const marker: RootMarker = { product: "LiveNest", version: 1, id: randomUUID() };
  await writeFile(path.join(root, ROOT_MARKER), JSON.stringify(marker), { flag: "wx" });
  return marker;
}
/** 旧配置是唯一迁入依据；只接受已知结构和匹配的自有 OBS。 */
export async function claimLegacyRoot(settings: Settings, installation?: string) {
  const root = await checkRootPath(settings.dataRoot, installation);
  const names = await readdir(root);
  if (names.includes(ROOT_MARKER)) return readRoot(root);
  if (names.some(n => !["obs", "media", "state", "logs", "temp"].includes(n))) throw new Error("旧数据目录含未知文件，未自动接管；请保留目录并检查。");
  for (const item of [...settings.instances, ...(settings.candidates || []), ...(settings.archivedCandidates || [])]) {
    if (!item.managed) continue;
    const obs = await ordinaryPath(path.resolve(item.exe, "../../.."));
    if (!within(root, obs)) throw new Error("旧托管 OBS 位于数据目录之外，未更改配置。");
    try { if (await readFile(path.join(obs, ".livenest-owner"), "utf8") !== item.id) throw new Error("旧 OBS 归属不匹配。"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" || item.initialized || (await readdir(obs).catch(error => { if(error.code === "ENOENT") return []; throw error; })).length) throw e; }
  }
  const marker: RootMarker = { product: "LiveNest", version: 1, id: randomUUID() };
  await writeFile(path.join(root, ROOT_MARKER), JSON.stringify(marker), { flag: "wx" }); return marker;
}
/** 业务文件存在时必须迁移；仅初始化配置和空骨架不算正式数据。 */
export async function hasData(settings: Settings): Promise<boolean> {
  if (settings.instances.length || settings.candidates?.length || settings.archivedCandidates?.length || settings.identity || settings.paired || settings.google || settings.maintenance || settings.inventoryPending) return true;
  if (!settings.dataRoot) return false;
  /** 递归检查目录，不跟随链接；仅忽略当前定位所需的桌面配置。 */
  async function populated(dir: string): Promise<boolean> {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name); const relative = path.relative(settings.dataRoot, file);
      if (relative === ROOT_MARKER || relative === path.join("state", "desktop", "settings.json")) continue;
      const info = await lstat(file);
      if (!info.isDirectory() || info.isSymbolicLink() || await populated(file)) return true;
    }
    return false;
  }
  return populated(settings.dataRoot);
}
