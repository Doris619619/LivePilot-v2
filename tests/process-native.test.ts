/** Windows 原生进程识别：使用临时 Node 副本，不启动或接管真实 OBS。 */
import { it, expect } from "vitest";
import { mkdtemp, mkdir, copyFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { obsProcessQuery } from "../src/core/obs/process-query";
const exec = promisify(execFile);
it.skipIf(process.platform !== "win32")("matches kernel executable identity across a junction and rejects duplicate instances", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "livenest-process-")); const children: ChildProcess[] = [];
  const first = path.join(root, "first", "obs64.exe"); const second = path.join(root, "second", "obs64.exe");
  /** 仅启动临时 Node 副本并记录所有句柄供 finally 清理。 */
  async function launch(exe: string) { const child = spawn(exe, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" }); children.push(child); await once(child, "spawn"); return child.pid; }
  /** 与正式进程识别使用同一原生脚本，避免 mock 掩盖路径错误。 */
  async function query(exe: string) { return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", obsProcessQuery], { windowsHide: true, timeout: 15_000, env: { ...process.env, LIVEPILOT_TARGET_EXE: exe } }); }
  try {
    for (const exe of [first, second]) { await mkdir(path.dirname(exe)); await copyFile(process.execPath, exe); }
    // 某些 Windows 用户目录和临时目录使用 8.3 名称；实际从短路径启动。
    const shortScript = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortName { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string path, StringBuilder buffer, uint size); }'
$buffer=[Text.StringBuilder]::new(32768)
if([ShortName]::GetShortPathName($env:LIVEPILOT_TARGET_EXE,$buffer,32768) -eq 0){throw 'Cannot query short path'}
$buffer.ToString()`;
    const short = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", shortScript], { windowsHide: true, timeout: 15_000, env: { ...process.env, LIVEPILOT_TARGET_EXE: first } })).stdout.trim();
    const a = await launch(short); const b = await launch(second);
    await symlink(path.dirname(first), path.join(root, "alias"), "junction");
    expect(JSON.parse((await query(path.join(root, "alias", "obs64.exe"))).stdout).pid).toBe(a);
    expect(JSON.parse((await query(second)).stdout).pid).toBe(b);
    await launch(first); await expect(query(first)).rejects.toThrow("Multiple matching OBS processes");
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } }));
    // root 来自专用临时目录，junction 仅指向该目录内；不接触用户 OBS。
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("livenest-process-")) throw new Error("Unsafe test cleanup path");
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
