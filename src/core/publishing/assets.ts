/** 普通视频素材轻量索引；扫描只读文件属性，完整 SHA-256 只在活动上传时计算。 */
import { readdir, realpath, stat, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveMedia, scanMedia } from "../media";
import { AppError } from "../errors";
import type { MediaAsset } from "@/shared/publishing";
/** 文件路径、大小和修改时间构成版本，不把轻量版本当作内容 Hash。 */
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
/** 图片仅来自 thumbnails 目录；拒绝链接逃逸、子目录和任意路径。 */
export async function resolvePublishingThumbnail(root: string, filename: string) {
  if (!filename || /[\\/:%\x00-\x1f]/.test(filename) || !/\.(png|jpe?g)$/i.test(filename)) throw new AppError("MEDIA", "缩略图必须为本地 PNG/JPEG 文件。");
  try {
    const base = await realpath(root); const folder = await realpath(path.join(base, "thumbnails")); const file = await realpath(path.join(folder, filename));
    for (const [parent, child] of [[base, folder], [folder, file]]) { const relative = path.relative(parent, child); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(); }
    const info = await stat(file); if (!info.isFile() || info.size > 50_000_000 || info.size === 0) throw new Error();
    const image = await open(file, "r"); const header = Buffer.alloc(8);
    try { await image.read(header, 0, 8, 0); } finally { await image.close(); }
    if (/\.png$/i.test(filename) ? header.toString("hex") !== "89504e470d0a1a0a" : header.subarray(0, 3).toString("hex") !== "ffd8ff") throw new Error();
    return file;
  } catch { throw new AppError("MEDIA", "缩略图不存在、超过 50 MB 或不在本地 thumbnails 目录。"); }
}
/** 固定封面沿用旧 thumbnails 目录，不要求同时准备直播视频。 */
export async function scanPublishingThumbnails(root: string) {
  const thumbnails: string[] = [];
  for (const name of await readdir(path.join(root, "thumbnails")).catch(e => { if (e.code === "ENOENT") return []; throw e; })) { try { await resolvePublishingThumbnail(root, name); thumbnails.push(name); } catch { /* 无效图片不进入可选列表。 */ } }
  return thumbnails;
}
/** 一次扫描视频和已准备的缩略图，不打开视频内容流。 */
export async function scanPublishingAssets(root: string) {
  const media = await scanMedia(root);
  if (media.error && !media.videos.length) throw new AppError("MEDIA", media.error);
  const thumbnails = await scanPublishingThumbnails(root);
  const assets: MediaAsset[] = [];
  for (const filename of media.videos) {
    const file = await resolveMedia(root, "videos", filename); const info = await stat(file);
    if (!info.size || info.size > 256 * 1024 ** 3) continue;
    const version = digest(JSON.stringify([filename, info.size, info.mtimeMs]));
    const thumbnail = thumbnails.find(n => path.parse(n).name.toLowerCase() === path.parse(filename).name.toLowerCase());
    assets.push({ id: digest(filename), filename, size: info.size, mtimeMs: info.mtimeMs, version, sha256: null, hashState: "not_computed", ...(thumbnail ? { thumbnail } : {}) });
  }
  assets.sort((a, b) => a.filename.localeCompare(b.filename, "en", { numeric: true }));
  return { assets, thumbnails };
}
/** 使用上传快照校验活动文件；重启后完整校验与此前内容 Hash 一致。 */
export async function validateAsset(root: string, asset: MediaAsset, expectedHash?: string, signal?: AbortSignal) {
  const file = await resolveMedia(root, "videos", asset.filename); const before = await stat(file);
  if (before.size !== asset.size || before.mtimeMs !== asset.mtimeMs) throw new AppError("ASSET_CHANGED", "视频在排期后发生变化，请重新选择素材确认。");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  const sha256 = hash.digest("hex"); const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (expectedHash && expectedHash !== sha256)) throw new AppError("ASSET_CHANGED", "视频内容与上传检查点不一致，已停止续传。");
  return { file, sha256 };
}
