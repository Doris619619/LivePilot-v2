/** 按 exe 真实路径与原生 TCP 监听表识别 Portable OBS，避免慢速网络 CIM 查询阻塞启动。 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { AppError } from "../errors";
const exec = promisify(execFile);
export type ProcessStatus = { pid: number | null; portPid: number | null };

/** 两侧均解析真实路径，兼容 MSIX 文件重定向和目录链接；多个匹配进程仍拒绝操作。 */
export async function matchingObsPid(output: string, target: string, resolvePath: (filename: string) => Promise<string> = realpath): Promise<number | null> {
  let candidates: { pid: number; exe: string }[];
  try {
    const value = JSON.parse(output) as { processes?: unknown };
    if (!Array.isArray(value.processes) || value.processes.some(p => !p || !Number.isSafeInteger(p.pid) || p.pid <= 0 || typeof p.exe !== "string" || !p.exe)) throw new Error();
    candidates = value.processes;
  } catch { throw new AppError("OBS_PROCESS", "Windows 返回的 OBS 进程状态无效，已停止启动操作。"); }
  const matched: number[] = [];
  for (const candidate of candidates) {
    // 无法读取其他用户的程序路径时不认领该进程；监听归属检查仍会阻止抢占端口。
    const actual = await resolvePath(candidate.exe).catch(() => undefined);
    if (actual?.toLowerCase() === target.toLowerCase()) matched.push(candidate.pid);
  }
  if (matched.length > 1) throw new AppError("OBS_PROCESS", "指定 OBS 存在多个进程，请关闭重复实例后重试。");
  return matched[0] ?? null;
}

/** 解析 netstat 数字输出中的目标监听 PID；不接受远端端口或 ESTABLISHED 连接。 */
export function listenerPid(output: string, port: number): number | null {
  const owners = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== "TCP" || !["LISTENING", "LISTEN"].includes(fields[3])) continue;
    if (Number(fields[1].slice(fields[1].lastIndexOf(":") + 1)) !== port) continue;
    const pid = Number(fields[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new AppError("OBS_PORT", "无法确认 OBS 端口的进程归属，已停止启动操作。");
    owners.add(pid);
  }
  if (owners.size > 1) throw new AppError("OBS_PORT", "目标 WebSocket 端口存在多个监听进程，请为 OBS 设置独立端口。");
  return [...owners][0] || null;
}

export class ObsProcessManager {
  /** 注入所属实例的配置，所有检查和启动只针对该 exe。 */
  constructor(private readConfig = config) {}
  /** 进程查询只使用 Win32_Process；端口使用 netstat，避免 Get-NetTCPConnection 超时。 */
  async inspect(): Promise<ProcessStatus> {
    const c = this.readConfig();
    if (process.platform !== "win32") throw new AppError("OBS_PROCESS", "OBS 启动器仅支持 Windows。");
    if (!c.obsExe || !path.isAbsolute(c.obsExe) || path.basename(c.obsExe).toLowerCase() !== "obs64.exe") throw new AppError("CONFIG", "请配置 Portable OBS 的绝对 obs64.exe 路径。");
    let exe: string;
    try { exe = await realpath(c.obsExe); }
    catch { throw new AppError("OBS_PATH", "找不到指定的 obs64.exe，请检查该实例的 OBS_EXE 路径与文件权限。"); }
    const script = `$ErrorActionPreference='Stop'
$candidates=@(Get-CimInstance Win32_Process -Filter "Name = 'obs64.exe'" | Where-Object { $_.ExecutablePath } | ForEach-Object { @{pid=[int]$_.ProcessId;exe=$_.ExecutablePath} })
@{processes=$candidates}|ConvertTo-Json -Compress`;
    let processOutput: string; let networkOutput: string;
    try {
      const [processResult, networkResult] = await Promise.all([
        exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }),
        exec("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
      ]);
      processOutput = processResult.stdout; networkOutput = networkResult.stdout;
    } catch (error) {
      if ((error as { killed?: boolean }).killed) throw new AppError("OBS_INSPECT_TIMEOUT", "Windows 进程或端口查询超时，尚未执行 OBS 启动。请稍后重试并检查系统负载。");
      throw new AppError("OBS_PROCESS", "无法检查指定 OBS。请确认只有一个该实例，并允许读取进程与端口信息。");
    }
    const pid = await matchingObsPid(processOutput.trim(), exe);
    return { pid, portPid: listenerPid(networkOutput, c.wsPort) };
  }
  /** 已运行则复用，端口属于其他进程时拒绝启动；启动程序与开始推流是不同操作。 */
  async ensureRunning() {
    const current = await this.inspect();
    if (current.portPid && current.portPid !== current.pid) throw new AppError("OBS_PORT", "WebSocket 端口被其他进程占用。请为这个 Portable OBS 配置独立端口。");
    if (current.pid) return;
    const c = this.readConfig();
    await new Promise<void>((resolve, reject) => {
      try {
        const child = spawn(c.obsExe, ["--portable", "--multi"], { cwd: path.dirname(c.obsExe), detached: true, windowsHide: true, stdio: "ignore" });
        child.once("error", () => reject(new AppError("OBS_PROCESS", "OBS 启动失败。请检查 exe 路径和执行权限。")));
        child.once("spawn", () => { child.unref(); resolve(); });
      } catch { reject(new AppError("OBS_PROCESS", "OBS 启动参数或系统环境无效，请检查 exe 路径和执行权限。")); }
    });
  }
}
