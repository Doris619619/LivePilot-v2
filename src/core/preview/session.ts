/** Agent 私有预览会话：每次读取重新解析素材、核对文件版本，检查与合成交由 Runner 限流。 */
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { Store } from "../storage";
import { AppError } from "../errors";
import { resolveMedia } from "../media";
import { readThumbnail } from "../broadcast-assets";
import { resolvePublishingThumbnail } from "../publishing/assets";
import { packageDigest, publishingRoot, resolvePackageFile, scanPublishingPackages, validatePackage } from "../publishing/packages";
import { toolsFor } from "../publishing/render";
import { PublishingRunner } from "../publishing/runner";
import type { ContentPackage } from "@/shared/publishing";
import { PREVIEW_TTL, type PreviewCommand, type PreviewFile, type PreviewPart, type PreviewSource, type PreviewState, type PreviewTarget } from "@/shared/media-preview";
import { decodeCheck, inspectMetadata } from "./inspect";
type Asset = { file?: string; bytes?: Buffer; info: PreviewFile };
type Session = { source: PreviewSource; target: PreviewTarget; state: PreviewState; assets: Partial<Record<PreviewPart, Asset>>; pkg?: ContentPackage; abort?: AbortController; work?: Promise<void> };
const mime: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
/** 文件身份包括 ctime 和 inode，避免仅同名或同长度替换后继续旧会话。 */
async function assetFor(file: string): Promise<Asset> { const info = await stat(file); if (!info.isFile() || !info.size) throw new AppError("MEDIA_READ", "文件为空或不可读取。"); return { file, info: { name: path.basename(file), size: info.size, version: packageDigest([file, info.size, info.mtimeMs, info.ctimeMs, info.ino]), mime: mime[path.extname(file).toLowerCase()] || "application/octet-stream" } }; }
export class AgentPreviewSessions {
  private sessions = new Map<string, Session>();
  private stopped = false;
  /** authorize 每次核对实例、账号和频道；不允许旧会话借用其他授权上下文。 */
  constructor(private runner: PublishingRunner, private authorize: (target: PreviewTarget) => Promise<void>) {}
  /** 过期清理连带取消所有检查；无需持久化媒体会话。 */
  sweep() { for (const [id, session] of this.sessions) if (session.state.expires <= Date.now()) { session.abort?.abort(); this.sessions.delete(id); } }
  /** 停止时等待 FFmpeg 释放，防止后台进程遗留。 */
  async stop() { this.stopped = true; const values = [...this.sessions.values()]; for (const item of values) item.abort?.abort(); this.sessions.clear(); await Promise.allSettled(values.map(s => s.work)); }
  /** 异步授权和磁盘解析结束后重验退出状态，禁止迟到请求重新创建检查。 */
  private requireRunning() { if (this.stopped) throw new AppError("PREVIEW_STOPPED", "设备正在退出，请重新连接后预览。", 410); }
  /** 包在 Agent 扫描并以标识和版本定位；浏览器永远不能传实际路径。 */
  private async resolve(source: PreviewSource, target: PreviewTarget, known?: ContentPackage) {
    const assets: Session["assets"] = {}; let pkg: ContentPackage | undefined;
    if (source.kind === "package") {
      pkg = known || (await scanPublishingPackages(publishingRoot())).batches.flatMap(b => b.packages).find(p => p.id === source.packageId);
      if (known) { try { await validatePackage(publishingRoot(), known); } catch { throw new AppError("ASSET_CHANGED", "发布包已改变或不可读取，请刷新素材后重新预览。", 409); } }
      if (!pkg || pkg.version !== source.version) throw new AppError("ASSET_CHANGED", "发布包已改变，请刷新素材后重新预览。", 409);
      for (const [part, value, kind] of [["video", pkg.sourceVideo, "video"], ["music", pkg.sourceMusic, "music"], ["cover", source.noCover || source.thumbnail ? undefined : pkg.cover, "cover"]] as const) if (value) assets[part] = await assetFor(await resolvePackageFile(publishingRoot(), pkg, value, kind));
      if (source.thumbnail) assets.cover = await assetFor(await resolvePublishingThumbnail(config(target.instanceId).mediaRoot, source.thumbnail));
    } else {
      assets.video = await assetFor(await resolveMedia(config(target.instanceId).mediaRoot, "videos", source.video));
      if (source.music) assets.music = await assetFor(await resolveMedia(config(target.instanceId).mediaRoot, "music", source.music));
      if (source.coverId) { const cover = await readThumbnail(new Store(config(target.instanceId).dataDir), source.coverId); const bytes = Buffer.from(cover.data, "base64"); assets.cover = { bytes, info: { name: cover.name, mime: cover.mime, size: bytes.length, version: packageDigest(cover) } }; }
    }
    if (!assets.video) throw new AppError("MEDIA_READ", "素材缺少可读取的视频。");
    return { assets, pkg };
  }
  /** 任何文件变化均撤销会话，不静默切换成新文件；成片也逐次核对固定版本。 */
  private async validate(session: Session) {
    await this.authorize(session.target);
    const fresh = await this.resolve(session.source, session.target, session.pkg);
    for (const part of ["video", "music", "cover"] as const) if (fresh.assets[part]?.info.version !== session.assets[part]?.info.version) throw new AppError("ASSET_CHANGED", "素材已被替换，请关闭后重新预览。", 409);
    if (session.assets.final?.file && (await assetFor(session.assets.final.file)).info.version !== session.assets.final.info.version) throw new AppError("ASSET_CHANGED", "最终成片已改变，请重新准备。", 409);
  }
  /** 异步检查先返回状态；取消或忙碌有明确结果，完成前不宣称文件完整。 */
  private start(session: Session, operation: "quick" | "check" | "prepare") {
    if (session.state.busy) throw new AppError("PREVIEW_BUSY", "当前检查尚未结束，请等待或取消。", 409);
    const abort = new AbortController(); session.abort = abort; session.state.busy = true; session.state.operation = operation; delete session.state.error; delete session.state.message;
    const checkedParts: PreviewPart[] = operation === "prepare" ? ["final"] : ["video", "music"];
    for (const part of checkedParts) { const info = session.state.files[part]; if (info) info.check = { state: "pending", coverage: operation === "check" ? "full" : "sample" }; }
    session.work = this.runner.previewWork(abort.signal, async signal => {
      if (operation === "prepare") {
        if (!session.pkg) throw new AppError("PREVIEW_SOURCE", "直播素材不生成发布成片。");
        await validatePackage(publishingRoot(), session.pkg);
        const result = await this.runner.preparePreview(session.pkg, signal); session.assets.final = await assetFor(result.file); session.state.files.final = session.assets.final.info;
      }
      const tools = await toolsFor(publishingRoot());
      const parts: PreviewPart[] = operation === "prepare" ? ["final"] : ["video", "music"];
      for (const part of parts) {
        const asset = session.assets[part]; if (!asset?.file) continue;
        await inspectMetadata(asset.file, asset.info, tools, signal);
        if (part !== "music" && !asset.info.video) throw new AppError("MEDIA_TRACK", "文件没有可读取的视频轨。");
        await decodeCheck(asset.file, asset.info, tools, operation === "check", signal, check => { asset.info.check = check; });
      }
      await this.validate(session); signal.throwIfAborted();
    }).catch(error => {
      session.state.error = error instanceof AppError ? error.message : abort.signal.aborted ? "检查已取消。" : "检查未完成，请重试。";
      for (const part of (operation === "prepare" ? ["final"] : ["video", "music"]) as PreviewPart[]) {
        const info = session.state.files[part]; if (!info || info.check?.state === "complete") continue;
        info.check = { ...info.check, coverage: operation === "check" ? "full" : "sample", state: abort.signal.aborted ? "cancelled" : error instanceof AppError && ["FFMPEG_MISSING", "PREVIEW_BUSY"].includes(error.code) ? "unavailable" : "failed", message: session.state.error };
      }
    }).finally(() => { session.state.busy = false; session.abort = undefined; });
  }
  /** 所有分片先重验版本，再打开并核对句柄；每次只分配请求上限内的缓冲区。 */
  async execute(command: PreviewCommand): Promise<PreviewState | Uint8Array> {
    this.requireRunning();
    this.sweep();
    const existing = this.sessions.get(command.session);
    if (command.action === "close" && existing && JSON.stringify(existing.target) === JSON.stringify(command.target)) { existing.abort?.abort(); this.sessions.delete(command.session); return existing.state; }
    await this.authorize(command.target);
    this.requireRunning();
    if (command.action === "open") {
      if (!command.source || this.sessions.has(command.session) || this.sessions.size >= 24) throw new AppError("PREVIEW_BUSY", "预览会话已存在或过多。", 409);
      const resolved = await this.resolve(command.source, command.target);
      this.requireRunning();
      const session: Session = { ...resolved, source: command.source, target: command.target, state: { expires: Math.min(command.expires, Date.now() + PREVIEW_TTL), busy: false, files: Object.fromEntries(Object.entries(resolved.assets).map(([part, asset]) => [part, asset!.info])) } };
      this.sessions.set(command.session, session); this.start(session, "quick"); return session.state;
    }
    const session = this.sessions.get(command.session);
    if (!session || JSON.stringify(session.target) !== JSON.stringify(command.target)) throw new AppError("PREVIEW_EXPIRED", "预览会话已失效，请重新打开。", 410);
    if (command.action === "close") { session.abort?.abort(); this.sessions.delete(command.session); return session.state; }
    if (command.action === "cancel") { session.abort?.abort(); return session.state; }
    try { await this.validate(session); } catch (error) { session.abort?.abort(); this.sessions.delete(command.session); throw error; }
    this.requireRunning();
    if (command.action === "check" || command.action === "prepare") { this.start(session, command.action); return session.state; }
    if (command.action !== "bytes") return session.state;
    const asset = command.part && session.assets[command.part]; if (!asset || command.offset === undefined || !command.count || command.offset + command.count > asset.info.size) throw new AppError("RANGE", "预览读取范围无效。", 416);
    if (asset.bytes) return asset.bytes.subarray(command.offset, command.offset + command.count);
    const handle = await open(asset.file!, "r");
    try {
      const info = await handle.stat(); if (packageDigest([asset.file, info.size, info.mtimeMs, info.ctimeMs, info.ino]) !== asset.info.version) throw new AppError("ASSET_CHANGED", "素材已改变，请重新预览。", 409);
      const buffer = Buffer.alloc(command.count); const result = await handle.read(buffer, 0, command.count, command.offset);
      const after = await handle.stat(); if (result.bytesRead !== command.count || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new AppError("ASSET_CHANGED", "素材读取期间发生变化。", 409);
      return buffer;
    } finally { await handle.close(); }
  }
}
