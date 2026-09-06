import "server-only";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors";
const extensions = { videos: new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]), music: new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"]) };
export type MediaKind = keyof typeof extensions;
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
export async function resolveMedia(root: string, kind: MediaKind, filename: string) {
  if (!root || !path.isAbsolute(root)) throw new AppError("MEDIA", "请配置绝对路径 LIVEPILOT_MEDIA_ROOT，并创建 videos / music 文件夹。");
  if (!filename || /[\\/:%\x00-\x1f]/.test(filename) || filename === "." || filename === ".." || filename.endsWith(".") || filename.endsWith(" ") || !extensions[kind].has(path.extname(filename).toLowerCase())) {
    throw new AppError("MEDIA", "媒体文件名无效。请从媒体列表中选择文件。");
  }
  try {
    const base = await realpath(root);
    const folder = await realpath(path.join(base, kind));
    const target = await realpath(path.join(folder, filename));
    if (!inside(base, folder) || !inside(folder, target) || !(await stat(target)).isFile()) throw new Error();
    return target;
  } catch { throw new AppError("MEDIA", "媒体文件不存在、不可读，或链接指向媒体目录之外。请刷新媒体列表。"); }
}
export async function scanMedia(root: string) {
  const scan = async (kind: MediaKind) => {
    if (!root) throw new AppError("MEDIA", "请在 .env.local 配置 LIVEPILOT_MEDIA_ROOT，并添加 videos / music 文件。");
    const items = await readdir(path.join(root, kind), { withFileTypes: true }).catch(() => { throw new AppError("MEDIA", "无法读取媒体目录。请检查 videos / music 文件夹和访问权限。"); });
    const names: string[] = [];
    for (const item of items) {
      if (!extensions[kind].has(path.extname(item.name).toLowerCase())) continue;
      try { await resolveMedia(root, kind, item.name); names.push(item.name); } catch { /* Exclude invalid files and escaping symlinks. */ }
    }
    return names.sort((a, b) => a.localeCompare(b));
  };
  return { videos: await scan("videos"), music: await scan("music") };
}
