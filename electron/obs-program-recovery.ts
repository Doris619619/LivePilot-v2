/** 内置 OBS 程序恢复：只补缺失程序文件，场景、连接密码、授权和已有文件均保留。 */
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { AppError } from "../src/core/errors";
import type { DesktopInstance } from "../src/shared/desktop";
import { ordinaryPath, within } from "./data-root";
import { queryObsWindows } from "./obs-discovery";
const execute = promisify(execFile);
/** 补齐程序目录中的缺失文件，拒绝链接及目录类型冲突，绝不覆盖已有文件。 */
export async function copyMissingProgram(source: string, target: string): Promise<void> {
  await ordinaryPath(target); await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new AppError("OBS_CONFIG", "恢复资源包含链接，未继续复制。");
    const origin = path.join(source, entry.name); const destination = path.join(target, entry.name);
    const existing = await lstat(destination).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing?.isSymbolicLink() || (existing && entry.isDirectory() !== existing.isDirectory())) throw new AppError("OBS_CONFIG", "原程序目录存在链接或类型冲突，请保留目录并联系支持。");
    if (entry.isDirectory()) await copyMissingProgram(origin, destination);
    else if (entry.isFile() && !existing) await cp(origin, destination, { force: false, errorOnExist: true });
  }
}
/** 已排空 Agent 后仍要求所有 OBS 关闭，避免缺 exe 时猜测进程文件身份。 */
export async function assertAllObsClosed() {
  const count = await queryObsWindows("@(Get-Process obs64 -ErrorAction SilentlyContinue).Count");
  if (count !== 0) throw new AppError("OBS_MAINTENANCE", "恢复程序前请结束推流、录制并关闭所有 OBS。未关闭或替换任何运行中的程序。");
}
/** 在独立临时目录解压官方资源，仅拷贝三类程序目录；错误不删除原文件。 */
export async function restoreManagedProgram(item: DesktopInstance, dataRoot: string, resources: string) {
  if (!item.managed) throw new AppError("OBS_CONFIG", "手动 OBS 请恢复原安装程序，内置恢复不会覆盖外部软件。");
  const root = path.resolve(item.exe, "../../..");
  if (!within(dataRoot, root) || await readFile(path.join(root, ".livenest-owner"), "utf8") !== item.id) throw new AppError("OBS_CONFIG", "原 OBS 目录归属无法核对，未修改程序。");
  await assertAllObsClosed();
  const zip = path.join(resources, "vendor", "obs.zip"); await access(zip);
  const scratchRoot = path.join(dataRoot, "temp"); await ordinaryPath(scratchRoot); await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, "obs-recovery-"));
  try {
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LN_RECOVERY_ZIP -DestinationPath $env:LN_RECOVERY_ROOT -Force"], { windowsHide: true, timeout: 180_000, env: { ...process.env, LN_RECOVERY_ZIP: zip, LN_RECOVERY_ROOT: scratch } });
    await access(path.join(scratch, "bin", "64bit", "obs64.exe")); await assertAllObsClosed();
    for (const folder of ["bin", "data", "obs-plugins"]) await copyMissingProgram(path.join(scratch, folder), path.join(root, folder));
  } finally {
    if (path.dirname(scratch) === scratchRoot && path.basename(scratch).startsWith("obs-recovery-")) await rm(scratch, { recursive: true, force: true });
  }
}
