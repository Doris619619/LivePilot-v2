/** 固定 Inbox 中的两层发布包索引；视频仅读取属性，所有路径拒绝链接和目录逃逸。 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { dataRoot } from "../config";
import { AppError } from "../errors";
import { videoCopySchema } from "@/shared/video-metadata";
import type { ContentPackage, MediaAsset, PackageBatch } from "@/shared/publishing";

const videos = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
const music = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"]);
const ignored = new Set(["thumbs.db", ".ds_store", "desktop.ini"]);
const maximumBytes = 256 * 1024 ** 3;

/** 轻量版本只散列相对路径与文件属性，不作为视频内容 Hash。 */
export function packageDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** 路径段遵循 Windows 文件名边界，不能携带目录、设备名或编码绕过。 */
export function packageName(value: string) {
  if (!value || value.length > 255 || /[\\/:%\x00-\x1f]/.test(value) || value === "." || value === ".." || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new AppError("PACKAGE_PATH", "发布目录或文件名无效，请使用普通本地文件名。");
  return value;
}

/** 单独配置发布根；桌面 state 的上级才是 LiveNest 数据根，CLI 沿用自己的数据根。 */
export function publishingRoot(): string {
  const configured = process.env.LIVEPILOT_PUBLISHING_ROOT;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new AppError("PACKAGE_PATH", "发布目录必须使用本机绝对路径。");
    return path.resolve(configured);
  }
  const state = dataRoot();
  return path.join(path.basename(state).toLowerCase() === "state" ? path.dirname(state) : state, "Publishing");
}

/** 从磁盘根逐层确认普通目录；不存在叶子可创建，但任何 symlink/junction 都拒绝。 */
async function ordinaryDirectory(value: string, create = false): Promise<string> {
  if (!path.isAbsolute(value) || process.platform === "win32" && value.startsWith("\\\\")) throw new AppError("PACKAGE_PATH", "发布目录必须是本机磁盘上的绝对路径。");
  const absolute = path.resolve(value); const parent = path.dirname(absolute);
  if (parent !== absolute) await ordinaryDirectory(parent, create);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError("PACKAGE_PATH", "发布目录不能包含链接或普通文件。");
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create || parent === absolute) throw error;
    try { await mkdir(absolute); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
    return ordinaryDirectory(absolute);
  }
}

/** 固定子目录在使用前再次逐层检查，不接受任意相对路径或链接。 */
export async function publishingDirectory(root: string, segments: string[], create = false): Promise<string> {
  const base = await ordinaryDirectory(root, create);
  for (const segment of segments) packageName(segment);
  const target = await ordinaryDirectory(path.join(base, ...segments), create);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new AppError("PACKAGE_PATH", "发布目录超出所选电脑的数据位置。");
  return target;
}

/** 只在安全根内创建 Inbox、Working 和 Completed，不覆盖已有文件。 */
export async function ensurePublishingRoot(root: string): Promise<void> {
  for (const name of ["Inbox", "Working", "Completed"]) await publishingDirectory(root, [name], true);
}

/** 定位普通文件并逐层拒绝链接；管理文件可尚未存在，但目录必须已验证。 */
export async function publishingFile(root: string, segments: string[], optional = false): Promise<string> {
  if (!segments.length) throw new AppError("PACKAGE_PATH", "发布文件路径无效。");
  const filename = packageName(segments.at(-1)!); const directory = await publishingDirectory(root, segments.slice(0, -1));
  return fileInDirectory(directory, filename, optional);
}

/** 已核对的目录中定位普通文件，扫描阶段复用该边界以免逐文件重复解析所有磁盘祖先。 */
async function fileInDirectory(directory: string, filename: string, optional = false): Promise<string> {
  const target = path.join(directory, packageName(filename));
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new AppError("PACKAGE_PATH", "发布文件不能是链接、目录或特殊文件。");
    const actual = await realpath(target);
    if (path.dirname(actual) !== directory) throw new AppError("PACKAGE_PATH", "发布文件超出允许目录。");
    return actual;
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return target; throw error; }
}

/** 有界读取 UTF-8 文本，拒绝非法编码，不静默截断用户文案。 */
async function packageText(file: string, maximum: number) {
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const buffer = Buffer.alloc(maximum + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new AppError("PACKAGE_TEXT", "文案文件过大，请缩短后刷新。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)).replace(/^\uFEFF/, ""); }
    catch { throw new AppError("PACKAGE_TEXT", "文案文件必须使用 UTF-8 编码。"); }
  } finally { await handle.close(); }
}

/** 图片只读签名，先排除伪造或过大的缩略图，不完整读入视频。 */
async function packageCover(file: string, asset: MediaAsset) {
  if (asset.size > 50_000_000) throw new AppError("PACKAGE_COVER", "封面超过 50 MB。");
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const header = Buffer.alloc(8); await handle.read(header, 0, 8, 0);
    if (/\.png$/i.test(file) ? header.toString("hex") !== "89504e470d0a1a0a" : header.subarray(0, 3).toString("hex") !== "ffd8ff") throw new AppError("PACKAGE_COVER", "封面不是有效的 PNG/JPEG 图片。");
  } finally { await handle.close(); }
}

/** 普通文件属性变成稳定索引；身份基于相对路径，不随数据盘迁移改变。 */
async function indexFile(file: string, filename: string, logicalPath: string[]): Promise<MediaAsset> {
  const info = await stat(file);
  if (!info.size && !/^description\.txt$/i.test(filename) || info.size > maximumBytes) throw new AppError("PACKAGE_FILE", "文件为空或超过支持的 256 GiB。");
  return { id: packageDigest(logicalPath), filename, size: info.size, mtimeMs: info.mtimeMs, version: packageDigest([logicalPath, info.size, info.mtimeMs]), sha256: null, hashState: "not_computed" };
}

/** 单包错误归属到该行；目录结构、非支持媒体和重复附件都有明确原因。 */
async function scanPackage(root: string, batchName: string, name: string, location: string[]): Promise<ContentPackage> {
  const result: ContentPackage = { id: packageDigest([batchName, name]), batchName, name, version: packageDigest([]), validationState: "valid", issues: [] };
  const indexed: unknown[] = []; const videoFiles: MediaAsset[] = []; const musicFiles: MediaAsset[] = []; const covers: MediaAsset[] = [];
  try {
    const directory = await publishingDirectory(root, location);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
      if (ignored.has(entry.name.toLowerCase())) continue;
      try {
        packageName(entry.name);
        if (!entry.isFile()) throw new AppError("PACKAGE_STRUCTURE", entry.isSymbolicLink() ? "文件或目录链接不允许使用。" : "仅支持 Batch / Package / files，不能包含子目录。");
        const file = await fileInDirectory(directory, entry.name); const asset = await indexFile(file, entry.name, [batchName, name, entry.name]); indexed.push([entry.name, asset.size, asset.mtimeMs]);
        const ext = path.extname(entry.name).toLowerCase();
        if (videos.has(ext)) videoFiles.push(asset);
        else if (music.has(ext)) musicFiles.push(asset);
        else if (/^cover\.(png|jpe?g)$/i.test(entry.name)) { await packageCover(file, asset); covers.push(asset); }
        else if (/^title\.txt$/i.test(entry.name)) {
          const value = await packageText(file, 4096); const parsed = videoCopySchema.shape.title.safeParse(value);
          if (!parsed.success) throw new AppError("PACKAGE_TITLE", "标题须为 1–100 个 Unicode 字符，不能包含无效内容。");
          result.title = value;
        } else if (/^description\.txt$/i.test(entry.name)) {
          const value = await packageText(file, 5003); const parsed = videoCopySchema.shape.description.safeParse(value);
          if (!parsed.success) throw new AppError("PACKAGE_DESCRIPTION", "说明不能超过 5000 UTF-8 bytes。");
          result.description = value;
        } else throw new AppError("PACKAGE_FORMAT", "不支持的文件或格式。");
      } catch (error) { result.issues.push(entry.name + "：" + (error instanceof AppError ? error.message : "文件无法读取，请检查权限或是否仍在复制。")); }
    }
    if (!videoFiles.length) result.issues.push("缺少主视频。");
    if (videoFiles.length > 1) result.issues.push("发现多个主视频，请只保留一个。");
    if (musicFiles.length > 1) result.issues.push("发现多首音乐，请最多保留一首。");
    if (covers.length > 1) result.issues.push("发现多个封面，请只保留一个 cover 图片。");
    if (videoFiles.length === 1) result.sourceVideo = videoFiles[0];
    if (musicFiles.length === 1) result.sourceMusic = musicFiles[0];
    if (covers.length === 1) result.cover = covers[0];
  } catch (error) { result.issues.push(error instanceof AppError ? error.message : "发布包无法读取，请检查目录权限。"); }
  result.issues = result.issues.slice(0, 100); result.validationState = result.issues.length ? "invalid" : "valid";
  result.version = packageDigest([indexed, result.issues, result.title, result.description]); return result;
}

/** 指定批次的浅层扫描也用于归档恢复；逻辑批次名称保持原有包身份。 */
export async function inspectPackageBatch(root: string, name: string, location: string[] = ["Inbox", name]): Promise<PackageBatch> {
  packageName(name); const batch: PackageBatch = { id: packageDigest([name]), name, version: packageDigest([]), packages: [], issues: [] };
  const directory = await publishingDirectory(root, location);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
    if (ignored.has(entry.name.toLowerCase())) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) { batch.issues.push(entry.name + "：批次内只允许普通发布包目录。"); continue; }
    if (batch.packages.length >= 10000) { batch.issues.push("一个批次最多支持 10000 个发布包。"); break; }
    batch.packages.push(await scanPackage(root, name, entry.name, [...location, entry.name]));
  }
  if (!batch.packages.length) batch.issues.push("批次没有发布包。");
  batch.version = packageDigest([batch.packages.map(pkg => [pkg.id, pkg.version]), batch.issues]); return batch;
}

/** 扫描设备共享 Inbox，仅两层深度，坏批次或坏包不会使其他内容消失。 */
export async function scanPublishingPackages(root: string): Promise<{ root: string; batches: PackageBatch[] }> {
  await ensurePublishingRoot(root); const inbox = await publishingDirectory(root, ["Inbox"]); const batches: PackageBatch[] = [];
  for (const entry of (await readdir(inbox, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
    if (ignored.has(entry.name.toLowerCase())) continue;
    if (batches.length >= 1000) throw new AppError("PACKAGE_LIMIT", "发布目录最多支持 1000 个批次，请先整理已完成内容。");
    try { batches.push(await inspectPackageBatch(root, entry.name)); }
    catch (error) { batches.push({ id: packageDigest([entry.name]), name: entry.name, version: packageDigest([]), packages: [], issues: [error instanceof AppError ? error.message : "批次不是可读取的普通目录。"] }); }
  }
  return { root: await publishingDirectory(root, []), batches };
}

/** 仅定位快照声明的源文件，并核对大小和修改时间；角色不可通过任意文件名替换。 */
export async function resolvePackageFile(root: string, pkg: ContentPackage, asset: MediaAsset, kind: "video" | "music" | "cover"): Promise<string> {
  const expected = kind === "video" ? pkg.sourceVideo : kind === "music" ? pkg.sourceMusic : pkg.cover;
  if (!expected || expected.id !== asset.id || expected.version !== asset.version || expected.filename !== asset.filename) throw new AppError("PACKAGE_PATH", "文件不属于此发布包快照。");
  const file = await publishingFile(root, ["Inbox", pkg.batchName, pkg.name, asset.filename]); const info = await stat(file);
  if (info.size !== asset.size || info.mtimeMs !== asset.mtimeMs) throw new AppError("ASSET_CHANGED", "发布包文件已改变，请重新检查并确认计划。");
  return file;
}

/** 活动任务重新浅扫整个包，发现附件、文本、额外文件和目录的变化。 */
export async function validatePackage(root: string, pkg: ContentPackage): Promise<void> {
  const current = await scanPackage(root, packageName(pkg.batchName), packageName(pkg.name), ["Inbox", pkg.batchName, pkg.name]);
  if (pkg.validationState !== "valid" || current.validationState !== "valid" || current.id !== pkg.id || current.version !== pkg.version) throw new AppError("ASSET_CHANGED", "发布包在计划确认后发生变化，请重新检查内容；已有视频不会重复上传。");
}

/** 完整 Hash 仅用于活动素材，读取前后核对普通文件属性，支持安全中断。 */
export async function hashPackageFile(file: string, expectedHash?: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await ordinaryDirectory(path.dirname(file)); const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new AppError("PACKAGE_PATH", "不能读取链接或特殊文件。");
  const hash = createHash("sha256"); const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try { signal?.throwIfAborted(); for await (const chunk of handle.createReadStream({ signal, autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  const sha256 = hash.digest("hex"); const after = await lstat(file);
  if (after.isSymbolicLink() || !after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || expectedHash && expectedHash !== sha256) throw new AppError("ASSET_CHANGED", "文件内容与持久检查点不一致，已停止处理。");
  return sha256;
}
