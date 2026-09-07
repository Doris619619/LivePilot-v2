/** 按 exe 真实路径及监听端口归属识别并启动一个 Portable OBS；不关闭 OBS。 */
import "server-only";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { AppError } from "../errors";
const exec = promisify(execFile);
export type ProcessStatus = { pid: number | null; portPid: number | null };
export class ObsProcessManager {
  /** 注入所属实例配置，避免启动或检查另一个 OBS。 */
  constructor(private readConfig = config) {}
  /** 读取指定 exe 的真实路径、进程和端口归属；不接受其他 OBS 的监听端口。 */
  async inspect(): Promise<ProcessStatus> {
    const c = this.readConfig();
    if (process.platform !== "win32") throw new AppError("OBS_PROCESS", "此 MVP 的 OBS 启动器仅支持 Windows。");
    if (!c.obsExe || !path.isAbsolute(c.obsExe) || path.basename(c.obsExe).toLowerCase() !== "obs64.exe") throw new AppError("CONFIG", "请配置 Portable OBS 的绝对 obs64.exe 路径。");
    const script = `$ErrorActionPreference='Stop'
$obsMatches=@(Get-CimInstance Win32_Process -Filter "Name = 'obs64.exe'" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$env:LIVEPILOT_TARGET_EXE,[StringComparison]::OrdinalIgnoreCase) })
if($obsMatches.Count -gt 1){throw 'Multiple matching OBS processes'}
$listener=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:LIVEPILOT_TARGET_PORT) -ErrorAction SilentlyContinue)
$pidValue=$null
$portValue=$null
if($obsMatches.Count -eq 1){$pidValue=[int]$obsMatches[0].ProcessId}
if($listener.Count -gt 0){$portValue=[int]$listener[0].OwningProcess}
@{pid=$pidValue;portPid=$portValue}|ConvertTo-Json -Compress`;
    try {
      const exe = await realpath(c.obsExe);
      const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 15_000,
        env: { ...process.env, LIVEPILOT_TARGET_EXE: exe, LIVEPILOT_TARGET_PORT: String(c.wsPort) },
      });
      return JSON.parse(result.stdout.trim()) as ProcessStatus;
    } catch { throw new AppError("OBS_PROCESS", "无法检查指定 OBS。请确认 exe 存在、只有一个该实例，并允许读取进程与端口信息。"); }
  }
  /** 已运行则复用，否则以 Portable 多开模式启动该 exe；从不关闭 OBS。 */
  async ensureRunning() {
    const current = await this.inspect();
    if (current.portPid && current.portPid !== current.pid) throw new AppError("OBS_PORT", "WebSocket 端口被其他进程占用。请为这个 Portable OBS 配置独立端口。");
    if (current.pid) return;
    const c = this.readConfig();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(c.obsExe, ["--portable", "--multi"], {
        cwd: path.dirname(c.obsExe), detached: true, windowsHide: true, stdio: "ignore",
      });
      child.once("error", () => reject(new AppError("OBS_PROCESS", "OBS 启动失败。请检查 exe 路径和执行权限。")));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}
