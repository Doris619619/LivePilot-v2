/** 已由 Cloud 确认完成的批次显式归档；先写持久意图，目录移动中断后按同一 archiveId 恢复。 */
import { lstat, open, rename } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors";
import type { PackageBatch } from "@/shared/publishing";
import { PublishingStore } from "./storage";
import { ensurePublishingRoot, inspectPackageBatch, packageName, publishingDirectory, publishingFile } from "./packages";

type ArchiveRecord = { version: 1; archiveId: string; batchName: string; batchVersion: string; destination: string; state: "prepared" | "complete" };
const archiving = new Set<string>();

/** 已存在位置只接受普通目录；权限和链接错误不能伪装成不存在。 */
async function existsDirectory(root: string, segments: string[]): Promise<boolean> {
  try { await publishingDirectory(root, segments); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** 归档前后以同一逻辑批次身份检查两层目录，任何源变更停止确认。 */
async function checkBatch(root: string, batch: PackageBatch, segments: string[], source = false) {
  const actual = await inspectPackageBatch(root, batch.name, segments);
  if (actual.id !== batch.id || actual.version !== batch.version || actual.issues.length || !actual.packages.length || actual.packages.some(pkg => pkg.validationState !== "valid")) throw new AppError(source ? "ARCHIVE_SOURCE_CHANGED" : "ARCHIVE_UNCERTAIN", source ? "原批次已变化，尚未移动文件，请重新检查内容。" : "归档目录内容与快照不一致，请保留文件并核对归档结果。");
}

/** POSIX 同步目录元数据；Windows 使用先后同步持久日志并由目录 rename 原子落位。 */
async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
}

/** 整批源包移动到 Completed，Working 保留；调用方必须先检查远端完成和 Runner 无活动文件。 */
export async function archivePublishingBatch(root: string, batch: PackageBatch, archiveId: string): Promise<{ state: "complete"; destination: string }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(archiveId)) throw new AppError("PACKAGE_PATH", "归档指令标识无效。");
  packageName(batch.name);
  if (batch.issues.length || !batch.packages.length || batch.packages.some(pkg => pkg.validationState !== "valid")) throw new AppError("ARCHIVE_BATCH", "请先处理全部发布包，不能归档不完整批次。");
  let key: string | undefined; let ownsLock = false; let movePossible = false;
  try {
    await ensurePublishingRoot(root); const completed = await publishingDirectory(root, ["Completed"]); key = completed.toLowerCase();
    if (archiving.has(key)) throw new AppError("ARCHIVE_WAIT", "另一批内容正在归档，请稍候。", 409);
    archiving.add(key); ownsLock = true;
    const journal = new PublishingStore(await publishingDirectory(root, ["Completed", ".archives"], true)); const filename = archiveId + ".json";
    await publishingFile(root, ["Completed", ".archives", filename], true);
    const saved = await journal.read<ArchiveRecord>(filename); const destinationName = Array.from(batch.name).slice(0, 80).join("") + "--" + archiveId; packageName(destinationName);
    if (saved && (saved.version !== 1 || saved.archiveId !== archiveId || saved.batchName !== batch.name || saved.batchVersion !== batch.version || saved.destination !== destinationName || !["prepared", "complete"].includes(saved.state))) throw new AppError("ARCHIVE_ID", "归档标识已用于其他内容，请核对原批次状态。");
    const sourceSegments = ["Inbox", batch.name]; const destinationSegments = ["Completed", destinationName];
    const sourceExists = await existsDirectory(root, sourceSegments);
    let destinationExists: boolean;
    try { destinationExists = await existsDirectory(root, destinationSegments); }
    catch (error) { if (!saved && error instanceof AppError && error.code === "PACKAGE_PATH") throw new AppError("ARCHIVE_CONFLICT", "归档目标不是普通目录，没有移动或覆盖源文件。"); throw error; }
    if (saved?.state === "complete") {
      movePossible = true;
      if (!destinationExists) throw new AppError("ARCHIVE_MISSING", "已归档目录暂不可访问，请检查原数据位置。");
      await checkBatch(root, batch, destinationSegments); return { state: "complete", destination: path.join(completed, destinationName) };
    }
    if (destinationExists) {
      if (!saved) throw new AppError("ARCHIVE_CONFLICT", "归档目标已存在，没有移动或覆盖源文件。");
      movePossible = true;
      if (sourceExists) throw new AppError("ARCHIVE_UNCERTAIN", "原目录和归档目标同时存在，请保留两处文件并核对上次归档。");
      await checkBatch(root, batch, destinationSegments);
    } else {
      if (!sourceExists) throw new AppError("ARCHIVE_MISSING", "原批次暂不可访问，归档结果需要核对。");
      await checkBatch(root, batch, sourceSegments, true);
      const record: ArchiveRecord = { version: 1, archiveId, batchName: batch.name, batchVersion: batch.version, destination: destinationName, state: "prepared" };
      await journal.write(filename, record);
      const source = await publishingDirectory(root, sourceSegments); const destination = path.join(await publishingDirectory(root, ["Completed"]), destinationName);
      try { await lstat(destination); throw new AppError("ARCHIVE_CONFLICT", "归档目标已存在，没有覆盖任何源文件。"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      movePossible = true;
      await rename(source, destination); await syncDirectory(completed); await syncDirectory(await publishingDirectory(root, ["Inbox"]));
      await checkBatch(root, batch, destinationSegments);
    }
    await publishingFile(root, ["Completed", ".archives", filename], true);
    await journal.write(filename, { version: 1, archiveId, batchName: batch.name, batchVersion: batch.version, destination: destinationName, state: "complete" } satisfies ArchiveRecord);
    return { state: "complete", destination: path.join(completed, destinationName) };
  } catch (error) {
    if (!movePossible && error instanceof AppError && ["ARCHIVE_SOURCE_CHANGED", "ARCHIVE_CONFLICT", "ARCHIVE_WAIT", "ARCHIVE_ID"].includes(error.code)) throw error;
    throw new AppError("ARCHIVE_UNCERTAIN", "归档结果尚未核对，请保留原目录与归档日志，在原电脑检查后重试。", 409);
  } finally { if (ownsLock && key) archiving.delete(key); }
}
