/** Windows 数据迁移精确保留 NTFS 文件时间；路径只经 stdin 传入，不拼接 PowerShell 代码。 */
import { execFile } from "node:child_process";
import path from "node:path";
import { AppError } from "../src/core/errors";

export type MigrationFileTime = { relative: string; mtimeNs: string };
const script = String.raw`
$ErrorActionPreference='Stop'
$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
$request=[Text.Encoding]::UTF8.GetString($inputBytes) | ConvertFrom-Json
# 每个父级均拒绝重解析点；时间恢复不能通过链接写入其他位置。
function OrdinaryPath([string]$value, [bool]$file) {
  $full=[IO.Path]::GetFullPath($value)
  if ($full.StartsWith('\\') -or -not [IO.Path]::IsPathRooted($full)) { throw 'Invalid path' }
  $cursor=$full
  while ($cursor) {
    $attributes=[IO.File]::GetAttributes($cursor)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid path' }
    if ($cursor -eq $full -and $file) {
      if ($attributes -band [IO.FileAttributes]::Directory) { throw 'Invalid file' }
    } elseif (-not ($attributes -band [IO.FileAttributes]::Directory)) { throw 'Invalid directory' }
    $parent=[IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor=$parent
  }
  return $full
}
$source=OrdinaryPath ([string]$request.source) $false
$destination=OrdinaryPath ([string]$request.destination) $false
$sourcePrefix=$source.TrimEnd('\')+'\'
$destinationPrefix=$destination.TrimEnd('\')+'\'
foreach ($entry in $request.files) {
  $relative=[string]$entry.relative
  if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw 'Invalid file' }
  $original=OrdinaryPath ([IO.Path]::Combine($source,$relative)) $true
  $copied=OrdinaryPath ([IO.Path]::Combine($destination,$relative)) $true
  if (-not $original.StartsWith($sourcePrefix,[StringComparison]::OrdinalIgnoreCase) -or -not $copied.StartsWith($destinationPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid file' }
  # Node 的 bigint 纳秒转换为 .NET 自公元 1 年起的 100ns ticks，避免浮点舍入。
  $expectedTicks=[long](([decimal]$entry.mtimeNs / 100) + 621355968000000000)
  $modified=[IO.File]::GetLastWriteTimeUtc($original)
  if ($modified.Ticks -ne $expectedTicks) { throw 'Source changed' }
  [IO.File]::SetLastWriteTimeUtc($copied,$modified)
  [IO.File]::SetLastAccessTimeUtc($copied,[IO.File]::GetLastAccessTimeUtc($original))
  if ([IO.File]::GetLastWriteTimeUtc($copied).Ticks -ne $expectedTicks) { throw 'Time mismatch' }
}
[Console]::Out.Write('OK')
`;

/** 一次受限进程恢复已复制普通文件；源时间改变或无法精确保留时拒绝迁移提交。 */
export async function restoreWindowsFileTimes(source: string, destination: string, files: MigrationFileTime[]): Promise<void> {
  if (process.platform !== "win32") return;
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || files.some(file => !file.relative || path.isAbsolute(file.relative) || file.relative.split(/[\\/]/).some(part => !part || part === "." || part === "..") || file.relative.includes(":") || !/^\d+$/.test(file.mtimeNs))) throw new AppError("DATA", "复制文件的时间记录无效，没有切换数据位置。");
  const payload = Buffer.from(JSON.stringify({ source, destination, files }), "utf8").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error || stdout.trim() !== "OK") { reject(new AppError("DATA", "复制文件的时间校验失败或源文件已改变，没有切换数据位置。")); return; }
      resolve();
    });
    child.stdin?.on("error", () => { /* 进程回调统一报告失败，路径与上游输出不进入日志。 */ }); child.stdin?.end(payload);
  });
}
