/** 大文件分片上传、磁盘空间预留及发布；只操作媒体库内自有临时文件。 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, lstat, readdir, statfs, open, unlink, link } from "node:fs/promises";
import path from "node:path";
import { config, requireInstance } from "./config";
import { Store } from "./storage";
import { AppError, safeError } from "./errors";
import { audit } from "./audit";
import type { UploadStatus } from "@/shared/uploads";
import type { MediaKind } from "./media";

export const CHUNK_SIZE = 8 * 1024 * 1024;
const TTL = 7 * 86400_000;
const HEADROOM = 512 * 1024 * 1024;
type UploadRecord = UploadStatus & { actor: string; hashes: string[] };
type Input = { kind: MediaKind; filename: string; size: number; fingerprint: string };
const allowed = { videos: /\.(mp4|mkv|mov|webm|avi|m4v)$/i, music: /\.(mp3|wav|flac|aac|m4a|ogg)$/i };

/** 验证 ID 不允许路径输入。 */
function validId(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError("UPLOAD", "上传记录不存在。", 404);
}
/** 只允许目录的真实直接子目录，拒绝重定向整个上传区域的 junction。 */
async function childFolder(root: string, name: string, create = false) {
  const target = path.join(root, name);
  if (create) await mkdir(target, { recursive: true });
  if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new AppError("MEDIA", "媒体目录包含不安全的链接，请在直播电脑上检查。");
  return target;
}
/** 从配置确定实例所属库；请求不能指定文件系统路径。 */
async function location(instanceId: string) {
  requireInstance(instanceId);
  const configured = config(instanceId).mediaRoot;
  if (!configured || !path.isAbsolute(configured)) throw new AppError("MEDIA", "请在直播电脑配置素材库。");
  const root = await realpath(configured);
  return { root, temp: await childFolder(root, ".uploads", true) };
}
/** 元数据与临时文件位于相同磁盘，完成时硬链接发布后删除临时目录入口。 */
async function recordStore(temp: string, id: string) {
  validId(id);
  return new Store(await childFolder(temp, id));
}
/** 发布过的元数据不再用于预留磁盘，但保留到过期以处理丢失的完成响应。 */
function dto(record: UploadRecord): UploadStatus {
  const { id, instanceId, kind, filename, size, received, chunkSize, fingerprint, status, expiresAt, publishedName, error } = record;
  return { id, instanceId, kind, filename, size, received, chunkSize, fingerprint, status, expiresAt, publishedName, error };
}
/** 逐个移除自有文件，拒绝目录、链接和不认识的内容，避免递归删除。 */
async function removeTemporary(dir: string, includeMetadata = true) {
  const names = includeMetadata ? ["content.part", "upload.json"] : ["content.part"];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!(await lstat(file)).isFile()) throw new AppError("UPLOAD", "临时文件类型异常，请在直播电脑检查。");
      await unlink(file);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}
/** 扫描仅限本应用元数据；预留尚未接收的字节，过期数据在持锁后清理。 */
async function reserved(temp: string) {
  let bytes = 0;
  for (const name of await readdir(temp)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const store = await recordStore(temp, name);
    const record = await store.read<UploadRecord>("upload.json");
    if (!record) continue;
    if (record.expiresAt < Date.now()) {
      try { await store.exclusive(() => removeTemporary(store.dir), "upload.lock"); }
      catch (e) { if (!(e instanceof AppError && e.code === "BUSY")) throw e; }
    } else if (record.status !== "complete") bytes += record.size - record.received;
  }
  return bytes;
}
/** 以根级短锁原子预留容量；同名文件使用唯一后缀，绝不覆盖已有媒体。 */
export async function createUpload(instanceId: string, actor: string, input: Input) {
  const max = Number(process.env.LIVEPILOT_UPLOAD_MAX_BYTES || 20 * 1024 ** 3);
  if (!Number.isSafeInteger(max) || max <= 0) throw new AppError("CONFIG", "上传大小限制配置无效。");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > max) throw new AppError("SIZE", "文件为空或超过上传大小限制。", 413);
  if (!allowed[input.kind]?.test(input.filename) || input.filename.length > 180 || /[\\/:*?"<>|%\x00-\x1f]/.test(input.filename) || /[. ]$/.test(input.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(input.filename)) throw new AppError("MEDIA", "请选择支持的视频或音乐文件，文件名不能包含路径或特殊字符。");
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new AppError("UPLOAD", "文件校验信息无效。");
  const { root, temp } = await location(instanceId);
  await childFolder(root, input.kind);
  return new Store(temp).exclusive(async () => {
    const outstanding = await reserved(temp);
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize - outstanding < input.size + HEADROOM) throw new AppError("SPACE", "直播电脑磁盘空间不足，请先在 B 电脑整理空间。", 507);
    const id = randomUUID();
    const dir = await childFolder(temp, id, true);
    const store = new Store(dir);
    const record: UploadRecord = { id, instanceId, actor, ...input, received: 0, chunkSize: CHUNK_SIZE, status: "uploading", expiresAt: Date.now() + TTL, hashes: [] };
    const file = await open(path.join(dir, "content.part"), "wx", 0o600); await file.close();
    await store.write("upload.json", record);
    await audit(actor, "upload", instanceId, "created", id);
    return dto(record);
  }, "uploads.lock");
}
/** 上传续传绑定创建人和实例；更换用户不能拼接另一人的上传。 */
async function load(instanceId: string, actor: string, id: string) {
  const { root, temp } = await location(instanceId);
  const store = await recordStore(temp, id);
  const record = await store.read<UploadRecord>("upload.json");
  if (!record || record.actor !== actor || record.instanceId !== instanceId) throw new AppError("UPLOAD", "上传记录不存在或不属于当前账号。", 404);
  if (record.expiresAt < Date.now()) throw new AppError("UPLOAD", "上传记录已过期，请重新上传。", 410);
  return { root, store, record };
}
/** 查询服务器实际确认的字节数，刷新浏览器不重置上传记录。 */
export async function uploadStatus(instanceId: string, actor: string, id: string) { return dto((await load(instanceId, actor, id)).record); }
/** 分片采用顺序偏移及哈希幂等，落盘同步后才记录确认进度。 */
export async function uploadChunk(instanceId: string, actor: string, id: string, offset: number, hash: string, request: Request) {
  const { store, root } = await load(instanceId, actor, id);
  return store.exclusive(async () => {
    const { record } = await load(instanceId, actor, id);
    if (record.status !== "uploading") throw new AppError("UPLOAD", "该文件已进入校验或完成阶段。", 409);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_SIZE || offset > record.received || offset >= record.size || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError("OFFSET", "分片偏移或校验无效，请刷新上传状态。", 409);
    const expected = Math.min(CHUNK_SIZE, record.size - offset);
    if (offset < record.received) {
      if (record.hashes[offset / CHUNK_SIZE] !== hash) throw new AppError("HASH", "重传分片与原文件不同。", 409);
      await request.body?.cancel(); return dto(record);
    }
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < expected + HEADROOM) throw new AppError("SPACE", "直播电脑磁盘空间不足，上传已暂停。", 507);
    const filename = path.join(store.dir, "content.part");
    if (!(await lstat(filename)).isFile()) throw new AppError("UPLOAD", "上传临时文件异常。");
    const file = await open(filename, "r+");
    const reader = request.body?.getReader();
    let received = 0; const checksum = createHash("sha256");
    try {
      if (!reader) throw new AppError("UPLOAD", "分片内容为空。");
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        received += item.value.length;
        if (received > expected) { await reader.cancel(); throw new AppError("SIZE", "分片超过允许大小。", 413); }
        checksum.update(item.value);
        let written = 0;
        while (written < item.value.length) { const result = await file.write(item.value, written, item.value.length - written, offset + received - item.value.length + written); written += result.bytesWritten; }
      }
      if (received !== expected || checksum.digest("hex") !== hash) throw new AppError("HASH", "分片校验失败，请重试。", 409);
      await file.sync();
      record.received += received; record.hashes.push(hash); record.expiresAt = Date.now() + TTL;
      await store.write("upload.json", record);
      return dto(record);
    } catch (error) { await file.truncate(record.received); throw error; }
    finally { reader?.releaseLock(); await file.close(); }
  }, "upload.lock");
}
/** 先持久化校验阶段再返回 202；重复完成请求会读取现有结果。 */
export async function prepareFinish(instanceId: string, actor: string, id: string) {
  const { store } = await load(instanceId, actor, id);
  return store.exclusive(async () => {
    const { record } = await load(instanceId, actor, id);
    if (record.received !== record.size) throw new AppError("UPLOAD", "文件尚未传输完成。", 409);
    if (record.status !== "complete") {
      record.status = "verifying"; record.error = undefined;
      record.publishedName ||= path.parse(record.filename).name + "-" + record.id + path.extname(record.filename);
      await store.write("upload.json", record);
    }
    return dto(record);
  }, "upload.lock");
}
/** 流式重新核验每个分片，使用不覆盖的硬链接发布；崩溃后可重复执行完成请求。 */
export async function finishUpload(instanceId: string, actor: string, id: string) {
  const { store, root } = await load(instanceId, actor, id);
  return store.exclusive(async () => {
    const { record } = await load(instanceId, actor, id);
    if (record.status === "complete") return dto(record);
    if (record.status !== "verifying") throw new AppError("UPLOAD", "请先提交完成请求。");
    const part = path.join(store.dir, "content.part");
    if (!(await lstat(part)).isFile()) throw new AppError("UPLOAD", "临时文件异常。");
    const file = await open(part, "r");
    try {
      if ((await file.stat()).size !== record.size) throw new AppError("HASH", "文件长度校验失败，请取消后重新上传。");
      const buffer = Buffer.alloc(CHUNK_SIZE); const hashes: string[] = [];
      for (let offset = 0; offset < record.size; offset += CHUNK_SIZE) {
        const length = Math.min(CHUNK_SIZE, record.size - offset); let filled = 0;
        while (filled < length) { const result = await file.read(buffer, filled, length - filled, offset + filled); if (!result.bytesRead) throw new AppError("HASH", "文件不完整。"); filled += result.bytesRead; }
        const hash = createHash("sha256").update(buffer.subarray(0, length)).digest("hex");
        if (hash !== record.hashes[offset / CHUNK_SIZE]) throw new AppError("HASH", "文件校验失败，请取消后重新上传。");
        hashes.push(hash);
      }
      if (createHash("sha256").update(hashes.join("")).digest("hex") !== record.fingerprint) throw new AppError("HASH", "完整文件与选择的素材不一致，请取消后重新上传。");
    } finally { await file.close(); }
    const destination = path.join(await childFolder(root, record.kind), record.publishedName!);
    try { await link(part, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(destination); const original = await lstat(part);
      if (!existing.isFile() || existing.ino !== original.ino || existing.dev !== original.dev) throw new AppError("MEDIA", "目标名称已被占用，未覆盖已有文件。", 409);
    }
    record.status = "complete"; record.expiresAt = Date.now() + TTL;
    await store.write("upload.json", record);
    await removeTemporary(store.dir, false);
    await audit(actor, "upload", instanceId, "complete", id);
    return dto(record);
  }, "upload.lock");
}
/** 仅删除当前上传的自有临时文件；已发布素材不能通过此入口删除。 */
export async function cancelUpload(instanceId: string, actor: string, id: string) {
  const { store, record } = await load(instanceId, actor, id);
  await store.exclusive(() => removeTemporary(store.dir), "upload.lock");
  await audit(actor, "upload", instanceId, record.status === "complete" ? "dismissed" : "cancelled", id);
}

/** 完成校验失败时保留可行动错误，不向浏览器透出原始磁盘路径。 */
export async function uploadFailure(instanceId: string, actor: string, id: string, error: unknown) {
  const { store } = await load(instanceId, actor, id);
  await store.exclusive(async () => {
    const { record } = await load(instanceId, actor, id);
    if (record.status !== "complete") { record.error = safeError(error); await store.write("upload.json", record); }
  }, "upload.lock");
}
