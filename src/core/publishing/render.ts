/** Agent 发布包预处理：本机 FFmpeg 换音轨、版本缓存与固定上传文件的完整校验。 */
import { spawn } from "node:child_process";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import type { ContentPackage, MediaAsset } from "@/shared/publishing";
import { PublishingStore } from "./storage";
import { ensurePublishingRoot, hashPackageFile, packageDigest, publishingDirectory, publishingFile, resolvePackageFile, validatePackage } from "./packages";

export type PackageUpload = { asset: MediaAsset; relativePath: string; sha256: string };
type Tools = { ffmpeg: string; ffprobe: string };
type Probe = { duration: number; videoIndex?: number; audioIndex?: number; videoCodec?: string };
type RenderRecord = { version: 1; recipe: 1; packageVersion: string; state: "rendering" | "ready" | "failed"; sources?: { video: string; music: string }; upload?: PackageUpload; duration?: number; message?: string };
type RenderOptions = { signal?: AbortSignal; live?: () => boolean };
const generating = new Set<string>();

/** Abort 统一使用可被现有 Runner 识别的 AbortError，不标记为渲染成功。 */
function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }

/** 运行子进程使用参数数组且隐藏窗口，限制输出，不向页面回传原始命令或 stderr。 */
async function command(executable: string, args: string[], signal?: AbortSignal, onSpawn?: (pid: number) => Promise<void>): Promise<string> {
  checkAbort(signal);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = ""; let errorOutput = ""; let settled = false; let interrupted = false;
    const registered = child.pid && onSpawn ? onSpawn(child.pid) : Promise.resolve();
    void registered.catch(() => { child.kill(); });
    /** 退出与错误只结算一次；先保存 PID 以便跨进程生成锁保留实际执行者。 */
    const finish = async (error?: Error) => {
      if (settled) return; settled = true; signal?.removeEventListener("abort", abort);
      try { await registered; if (error) reject(error); else resolve(output); } catch (failure) { reject(failure); }
    };
    /** 中断只结束由当前 wrapper 创建的子进程，绝不按名称杀其他 FFmpeg。 */
    const abort = () => { interrupted = true; child.kill(); };
    child.stdout?.on("data", chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 1024 * 1024) { interrupted = true; child.kill(); } });
    child.stderr?.on("data", chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-8192); });
    child.on("error", () => { void finish(new AppError("FFMPEG_EXECUTION", "无法运行 FFmpeg 工具，请检查文件权限和安装是否完整。")); });
    child.on("close", code => {
      if (signal?.aborted) { void finish(signal.reason instanceof Error ? signal.reason : new DOMException("操作已停止。", "AbortError")); return; }
      if (interrupted || code !== 0) { void finish(new AppError("FFMPEG_FAILED", /no space left|not enough space/i.test(errorOutput) ? "磁盘空间不足，无法生成最终视频。" : "FFmpeg 生成失败，请检查源视频、音乐格式和磁盘空间。")); return; }
      void finish();
    });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}

/** 同一文件夹里的工具成对使用；本机 tools 优先，其次 PATH，不通过命令 shell 寻址。 */
async function toolsFor(root: string): Promise<Tools> {
  const local = path.join(path.dirname(root), "tools");
  const candidates = [{ folder: local, suffix: ".exe", local: true }, ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(folder => ({ folder: folder.replace(/^"|"$/g, ""), suffix: process.platform === "win32" ? ".exe" : "", local: false }))];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate.folder)) continue;
    try {
      if (candidate.local) { const info = await lstat(candidate.folder); if (info.isSymbolicLink() || !info.isDirectory()) continue; }
      const ffmpeg = path.join(candidate.folder, "ffmpeg" + candidate.suffix); const ffprobe = path.join(candidate.folder, "ffprobe" + candidate.suffix);
      const info = await Promise.all([lstat(ffmpeg), lstat(ffprobe)]);
      if (info.some(file => !file.isFile() && !file.isSymbolicLink()) || candidate.local && info.some(file => file.isSymbolicLink())) continue;
      return { ffmpeg: await realpath(ffmpeg), ffprobe: await realpath(ffprobe) };
    } catch { /* 工具未安装时继续检查下一个明确目录。 */ }
  }
  throw new AppError("FFMPEG_MISSING", "未检测到 FFmpeg，无法生成最终视频。请将 ffmpeg.exe 和 ffprobe.exe 放入 LiveNest 的 tools 目录，或安装到 PATH。");
}

/** ffprobe 仅输出结构化流与时长信息，不完整解码视频；无法确定长度时拒绝生成。 */
async function probe(file: string, tools: Tools, signal?: AbortSignal, onSpawn?: (pid: number) => Promise<void>): Promise<Probe> {
  const text = await command(tools.ffprobe, ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,duration:stream_disposition=attached_pic:format=duration", "-of", "json", file], signal, onSpawn);
  try {
    const value = JSON.parse(text) as { streams?: { index?: number; codec_type?: string; codec_name?: string; duration?: string; disposition?: { attached_pic?: number } }[]; format?: { duration?: string } };
    const video = value.streams?.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audio = value.streams?.find(stream => stream.codec_type === "audio"); const duration = Number(video?.duration || value.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error();
    return { duration, ...(video && Number.isInteger(video.index) ? { videoIndex: video.index, videoCodec: video.codec_name } : {}), ...(audio && Number.isInteger(audio.index) ? { audioIndex: audio.index } : {}) };
  } catch { throw new AppError("RENDER_MEDIA", "无法确认视频或音乐时长，请检查源文件是否完整且格式受支持。"); }
}

/** 只把明确不存在的 PID 视作已退出，权限错误保守地保留执行锁。 */
function alive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** 设备级持久生成锁：旧父进程退出后仍等待其已登记子进程，不并发写生成文件。 */
async function generationLock<T>(root: string, signal: AbortSignal | undefined, action: (onSpawn: (pid: number) => Promise<void>) => Promise<T>): Promise<T> {
  const directory = await publishingDirectory(root, ["Working"]); const key = directory.toLowerCase();
  if (generating.has(key)) throw new AppError("RENDER_WAIT", "另一条内容正在生成，请稍候。", 409);
  generating.add(key); let handle: Awaited<ReturnType<typeof open>> | undefined; let owned = false;
  try {
    const lock = await publishingFile(root, ["Working", ".render.lock"], true);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(lock, "wx", 0o600); owned = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const content = await readFile(await publishingFile(root, ["Working", ".render.lock"]), "utf8");
        let previous: { owner?: number; child?: number; token?: string };
        try { previous = JSON.parse(content); } catch { throw new AppError("RENDER_WAIT", "生成锁需要人工核对，请在原电脑查看诊断信息。", 409); }
        if (!Number.isInteger(previous?.owner) || Number(previous.owner) <= 0 || !Number.isInteger(previous.child) || Number(previous.child) < 0 || !/^[a-f0-9-]{36}$/.test(previous.token || "")) throw new AppError("RENDER_WAIT", "生成锁需要人工核对，请在原电脑查看诊断信息。", 409);
        if (alive(previous.owner) || alive(previous.child)) throw new AppError("RENDER_WAIT", "另一条内容正在生成，请稍候。", 409);
        if (await readFile(lock, "utf8") !== content) throw new AppError("RENDER_WAIT", "生成状态正在更新，请稍候。", 409);
        await unlink(lock);
      }
    }
    if (!handle) throw new AppError("RENDER_WAIT", "另一条内容正在生成，请稍候。", 409);
    const token = randomUUID();
    /** 覆盖当前锁记录并同步，父进程异常退出后能识别仍活着的 FFmpeg。 */
    const register = async (child: number) => { const bytes = Buffer.from(JSON.stringify({ owner: process.pid, child, token })); await handle!.truncate(bytes.length); await handle!.write(bytes, 0, bytes.length, 0); await handle!.sync(); };
    await register(0); checkAbort(signal); return await action(register);
  } finally {
    try {
      if (handle) await handle.close();
      if (owned) { const lock = await publishingFile(root, ["Working", ".render.lock"], true); await unlink(lock).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    } finally { generating.delete(key); }
  }
}

/** 每个包版本有独立缓存目录，后来的源文件版本不覆盖旧断点文件。 */
async function cacheStore(root: string, pkg: ContentPackage) {
  if (!/^[a-f0-9]{64}$/.test(pkg.version)) throw new AppError("PACKAGE_PATH", "发布包版本无效。");
  return new PublishingStore(await publishingDirectory(root, ["Working", pkg.batchName, pkg.name, pkg.version], true));
}

/** JSON 缓存必须是普通文件；损坏缓存不能当作一次成功渲染。 */
async function recordFor(root: string, pkg: ContentPackage, store: PublishingStore): Promise<RenderRecord | null> {
  await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "render.json"], true);
  const record = await store.read<RenderRecord>("render.json");
  if (record && (record.version !== 1 || record.recipe !== 1 || record.packageVersion !== pkg.version || !["rendering", "ready", "failed"].includes(record.state))) throw new AppError("RENDER_CACHE", "生成缓存格式无效，请保留文件并检查诊断信息。");
  return record;
}

/** 输出描述只暴露给 Agent 私有检查点；尺寸和版本在原子落位后生成。 */
async function outputDescriptor(root: string, pkg: ContentPackage, signal?: AbortSignal): Promise<PackageUpload> {
  const segments = ["Working", pkg.batchName, pkg.name, pkg.version, "output.mp4"]; const file = await publishingFile(root, segments); const info = await stat(file);
  if (!info.size || info.size > 256 * 1024 ** 3) throw new AppError("RENDER_OUTPUT", "最终视频为空或超过支持的文件大小。");
  const sha256 = await hashPackageFile(file, undefined, signal);
  return { asset: { id: packageDigest(segments), filename: "output.mp4", size: info.size, mtimeMs: info.mtimeMs, version: packageDigest([segments, info.size, info.mtimeMs]), sha256, hashState: "verified" }, relativePath: segments.join("/"), sha256 };
}

/** 固定输入映射只保留原视频画面和音乐，短音乐循环，长音乐按原视频时长截断。 */
function renderArguments(video: string, audio: string, output: string, source: Probe, track: Probe, transcode: boolean): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-i", video, "-stream_loop", "-1", "-threads", "2", "-i", audio, "-map", "0:" + source.videoIndex, "-map", "1:" + track.audioIndex, "-c:v", transcode ? "libx264" : "copy", ...(transcode ? ["-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads:v", "2"] : []), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-threads:a", "2", "-t", String(source.duration), "-sn", "-dn", "-movflags", "+faststart", "-f", "mp4", output];
}

/** 活动包生成最终上传文件；只有已验证缓存可复用，存在半成品本身不代表成功。 */
export async function preparePackageUpload(root: string, pkg: ContentPackage, options: RenderOptions = {}): Promise<PackageUpload> {
  checkAbort(options.signal); await ensurePublishingRoot(root); await validatePackage(root, pkg);
  if (!pkg.sourceVideo) throw new AppError("PACKAGE_VIDEO", "发布包缺少主视频。");
  if (!pkg.sourceMusic) {
    const file = await resolvePackageFile(root, pkg, pkg.sourceVideo, "video"); const sha256 = await hashPackageFile(file, undefined, options.signal); await validatePackage(root, pkg);
    return { asset: { ...pkg.sourceVideo, sha256, hashState: "verified" }, relativePath: ["Inbox", pkg.batchName, pkg.name, pkg.sourceVideo.filename].join("/"), sha256 };
  }
  const store = await cacheStore(root, pkg); const existing = await recordFor(root, pkg, store);
  if (existing?.state === "ready" && existing.upload) { await validatePreparedUpload(root, existing.upload, pkg, options.signal); return existing.upload; }
  return generationLock(root, options.signal, async register => {
    await validatePackage(root, pkg);
    const finalFile = await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "output.mp4"], true);
    const finalExists = await lstat(finalFile).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
    if (finalExists && (!existing?.sources || !existing.duration || !["rendering", "failed"].includes(existing.state))) throw new AppError("RENDER_CACHE", "存在未经验证的最终视频，请保留文件并在原电脑检查后重试。");
    const tools = await toolsFor(root);
    const video = await resolvePackageFile(root, pkg, pkg.sourceVideo!, "video"); const audio = await resolvePackageFile(root, pkg, pkg.sourceMusic!, "music");
    // 原子落位后、ready 日志前崩溃时，只验证已有结果；没有生成意图则不得采用现存文件。
    if (existing?.sources && existing.duration && ["rendering", "failed"].includes(existing.state)) {
      const destination = await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "output.mp4"], true);
      const exists = await lstat(destination).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
      if (exists) {
        await hashPackageFile(video, existing.sources.video, options.signal); await hashPackageFile(audio, existing.sources.music, options.signal);
        const checked = await probe(destination, tools, options.signal, register);
        if (checked.videoIndex === undefined || checked.audioIndex === undefined || Math.abs(checked.duration - existing.duration) > Math.max(0.5, existing.duration * 0.001)) throw new AppError("RENDER_OUTPUT", "中断前的最终视频无法通过验证，没有重新生成或上传。");
        const upload = await outputDescriptor(root, pkg, options.signal); await validatePackage(root, pkg);
        await store.write("render.json", { ...existing, state: "ready", upload }); return upload;
      }
    }
    const sources = { video: await hashPackageFile(video, undefined, options.signal), music: await hashPackageFile(audio, undefined, options.signal) };
    const source = await probe(video, tools, options.signal, register); const track = await probe(audio, tools, options.signal, register);
    if (source.videoIndex === undefined || track.audioIndex === undefined) throw new AppError("RENDER_MEDIA", "发布包需要可读取的视频画面和音乐音轨。");
    const temporaryName = "output." + randomUUID() + ".partial.mp4"; const temporarySegments = ["Working", pkg.batchName, pkg.name, pkg.version, temporaryName];
    const output = await publishingFile(root, temporarySegments, true); const record: RenderRecord = { version: 1, recipe: 1, packageVersion: pkg.version, state: "rendering", sources, duration: source.duration };
    await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "render.json"], true); await store.write("render.json", record);
    try {
      try { await command(tools.ffmpeg, renderArguments(video, audio, output, source, track, false), options.signal, register); }
      catch (error) {
        checkAbort(options.signal); if (!(error instanceof AppError) || error.code !== "FFMPEG_FAILED") throw error;
        if (options.live?.()) throw new AppError("RENDER_WAIT", "正在直播，等待空闲后生成此视频。", 409);
        await publishingFile(root, temporarySegments, true); await command(tools.ffmpeg, renderArguments(video, audio, output, source, track, true), options.signal, register);
      }
      checkAbort(options.signal); const checkedOutput = await publishingFile(root, temporarySegments); const result = await probe(checkedOutput, tools, options.signal, register);
      if (result.videoIndex === undefined || result.audioIndex === undefined || Math.abs(result.duration - source.duration) > Math.max(0.5, source.duration * 0.001)) throw new AppError("RENDER_OUTPUT", "最终视频的画面、音轨或长度校验失败，没有开始上传。");
      await validatePackage(root, pkg); await hashPackageFile(video, sources.video, options.signal); await hashPackageFile(audio, sources.music, options.signal); checkAbort(options.signal);
      const destination = await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "output.mp4"], true);
      try { await lstat(destination); throw new AppError("RENDER_CACHE", "存在未经验证的最终视频，请保留文件并在原电脑检查后重试。"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const handle = await open(checkedOutput, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await rename(checkedOutput, destination); const upload = await outputDescriptor(root, pkg, options.signal);
      await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "render.json"], true); await store.write("render.json", { ...record, state: "ready", upload }); return upload;
    } catch (error) {
      await publishingFile(root, ["Working", pkg.batchName, pkg.name, pkg.version, "render.json"], true); await store.write("render.json", { ...record, state: "failed", message: error instanceof AppError ? error.message : "最终视频生成已中断，请重试。" }); throw error;
    } finally {
      await publishingFile(root, temporarySegments, true); await unlink(output).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  });
}

/** 已固定文件只验证不再生成；同时核对源包、来源 Hash 和最终输出的完整 Hash。 */
export async function validatePreparedUpload(root: string, descriptor: PackageUpload, pkg: ContentPackage, signal?: AbortSignal): Promise<{ file: string; sha256: string }> {
  checkAbort(signal); await validatePackage(root, pkg);
  const expected = pkg.sourceMusic ? ["Working", pkg.batchName, pkg.name, pkg.version, "output.mp4"] : ["Inbox", pkg.batchName, pkg.name, pkg.sourceVideo?.filename || ""];
  if (descriptor.relativePath !== expected.join("/") || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || descriptor.asset.sha256 && descriptor.asset.sha256 !== descriptor.sha256) throw new AppError("RENDER_CACHE", "最终视频检查点与发布包不一致，没有重新生成或上传。");
  const file = await publishingFile(root, expected); const info = await stat(file);
  if (descriptor.asset.size !== info.size || descriptor.asset.mtimeMs !== info.mtimeMs) throw new AppError("ASSET_CHANGED", "最终上传文件已变化，已停止恢复。");
  if (pkg.sourceMusic) {
    const store = await cacheStore(root, pkg); const record = await recordFor(root, pkg, store);
    if (record?.state !== "ready" || !record.sources || !record.upload || record.upload.relativePath !== descriptor.relativePath || record.upload.sha256 !== descriptor.sha256 || record.upload.asset.version !== descriptor.asset.version || record.upload.asset.size !== descriptor.asset.size || record.upload.asset.mtimeMs !== descriptor.asset.mtimeMs) throw new AppError("RENDER_CACHE", "最终视频没有可确认的完成记录，未重新生成已固定文件。");
    await hashPackageFile(await resolvePackageFile(root, pkg, pkg.sourceVideo!, "video"), record.sources.video, signal);
    await hashPackageFile(await resolvePackageFile(root, pkg, pkg.sourceMusic, "music"), record.sources.music, signal);
  }
  const sha256 = await hashPackageFile(file, descriptor.sha256, signal); await validatePackage(root, pkg); return { file, sha256 };
}
