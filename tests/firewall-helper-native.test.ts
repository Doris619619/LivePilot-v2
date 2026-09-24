/** Windows PowerShell 5 实际解析与中文目录/DPAPI 回归；防火墙命令全部替换，不提权、不修改系统。 */
import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
it.skipIf(process.platform !== "win32")("reads Unicode DPAPI settings in Windows PowerShell and refuses changed ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ln-firewall-native-"));
  const script = String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$fixtureDirectory=$env:LN_TEST_ROOT
$rootId=[guid]::NewGuid().ToString()
$utf8=New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path (Join-Path $fixtureDirectory 'state\desktop') -Force | Out-Null
$base=Join-Path $fixtureDirectory 'obs\main'
New-Item -ItemType Directory -Path (Join-Path $base 'bin\64bit') -Force | Out-Null
$exe=Join-Path $base 'bin\64bit\obs64.exe'
[IO.File]::WriteAllText($exe,'fixture - never executed',$utf8)
[IO.File]::WriteAllText((Join-Path $base '.livenest-owner'),$env:LN_TEST_OWNER,$utf8)
[IO.File]::WriteAllText((Join-Path $fixtureDirectory '.livenest-root.json'),(@{product='LiveNest';version=1;id=$rootId}|ConvertTo-Json),$utf8)
if($env:LN_TEST_SHORT -eq '1'){
 Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class TestShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string path, StringBuilder buffer, uint size); }'
 $buffer=New-Object Text.StringBuilder 32768
 if([TestShortPath]::GetShortPathName($fixtureDirectory,$buffer,32768) -eq 0){throw 'Cannot obtain short fixture path'}
 $fixtureDirectory=$buffer.ToString();$exe=Join-Path $fixtureDirectory 'obs\main\bin\64bit\obs64.exe'
}
$value=@{rootId=$rootId;dataRoot=$fixtureDirectory;instances=@(@{id='main';exe=$exe;port=14455;managed=$true;initialized=$true})}|ConvertTo-Json -Depth 8 -Compress
$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText((Join-Path $fixtureDirectory 'state\desktop\settings.json'),(ConvertTo-Json -InputObject ('dpapi:'+[Convert]::ToBase64String($bytes))),$utf8)
function global:Get-NetFirewallRule { param($PolicyStore,$Name,$Group,$ErrorAction) @() }
function global:New-NetFirewallRule { param($PolicyStore,$Name,$DisplayName,$Group,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$LocalPort,$RemoteAddress)
 if($Program -ine $env:LN_TEST_CANONICAL_EXE -or $LocalPort -ne 14455 -or $Action -ne 'Block' -or $Direction -ne 'Inbound'){throw 'Unexpected mock rule'}
 [Console]::WriteLine('MOCK_RULE_VALIDATED')
}
function global:Remove-NetFirewallRule { process {} }
& $env:LN_TEST_HELPER -Root64 ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fixtureDirectory))) -RootId $rootId`;
  const env = { ...process.env, LN_TEST_ROOT: path.join(root, "中文 数据"), LN_TEST_CANONICAL_EXE: path.join(await realpath(root), "中文 数据", "obs", "main", "bin", "64bit", "obs64.exe"), LN_TEST_OWNER: "main", LN_TEST_HELPER: path.resolve("scripts/desktop/obs-firewall.ps1") };
  try {
    expect((await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, windowsHide: true, timeout: 20_000 })).stdout).toContain("MOCK_RULE_VALIDATED");
    expect((await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...env, LN_TEST_SHORT: "1" }, windowsHide: true, timeout: 20_000 })).stdout).toContain("MOCK_RULE_VALIDATED");
    await expect(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...env, LN_TEST_OWNER: "other" }, windowsHide: true, timeout: 20_000 })).rejects.toThrow("instance-validation");
  } finally {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("ln-firewall-native-")) throw Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
