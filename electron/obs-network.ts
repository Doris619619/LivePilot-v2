/** 读取实际 TCP 监听和 Windows 防火墙有效策略；连接 loopback 不等于仅本机监听。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Check, DesktopInstance } from "../src/shared/desktop";
const exec = promisify(execFile);
/** 从 netstat 提取本地监听地址，不能用远端地址或 Agent 的连接 URL 代替。 */
export function listeningAddresses(output: string, port: number) {
  return [...new Set(output.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== "TCP" || !["LISTENING", "LISTEN"].includes(fields[3])) return [];
    const at = fields[1].lastIndexOf(":");
    return Number(fields[1].slice(at + 1)) === port ? [fields[1].slice(0, at).replace(/^\[|\]$/g, "")] : [];
  }))];
}
/** 仅所有实际监听均为回环时认定本机绑定；其余情况须单独验证防火墙。 */
export function loopbackOnly(addresses: string[]) { return addresses.length > 0 && addresses.every(a => a === "::1" || /^127\./.test(a)); }
// 保守检查所有配置文件和可能允许该程序/端口的规则；不自动添加或放宽入站规则。
const firewallQuery = String.raw`$ErrorActionPreference='Stop'
$profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore)
$blocked=$profiles.Count -eq 3 -and @($profiles|Where-Object { -not $_.Enabled -or $_.DefaultInboundAction -ne 'Block' }).Count -eq 0
$allows=@()
foreach($rule in @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow)) {
  $app=$rule|Get-NetFirewallApplicationFilter
  if($app.Program -ne 'Any' -and $app.Program -ne $env:LN_OBS_EXE){continue}
  $port=$rule|Get-NetFirewallPortFilter
  if($port.Protocol -ne 'TCP' -and $port.Protocol -ne '6' -and $port.Protocol -ne 'Any'){continue}
  foreach($value in @($port.LocalPort)) {
    if($value -eq 'Any' -or $value -eq $env:LN_OBS_PORT -or $value -match '-' -or $value -notmatch '^\d+$'){$allows+=1;break}
  }
}
@{isolated=($blocked -and $allows.Count -eq 0)}|ConvertTo-Json -Compress`;
/** 权限不足、策略含糊或开放接口均显式报待核查，不将它们解释为安全。 */
export async function checkObsNetwork(item: DesktopInstance): Promise<Check> {
  const base = { id: "network-" + item.id, label: item.name + " 网络隔离" };
  try {
    const network = await exec("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const addresses = listeningAddresses(network.stdout, item.port);
    if (!addresses.length) return { ...base, status: "pending", message: "当前没有监听；启动 OBS 后重新检查实际地址与防火墙。" };
    if (loopbackOnly(addresses)) return { ...base, status: "ready", message: "实际监听仅限本机：" + addresses.join("、") };
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", firewallQuery], { windowsHide: true, timeout: 25_000, env: { ...process.env, LN_OBS_EXE: item.exe, LN_OBS_PORT: String(item.port) } });
    if (JSON.parse(result.stdout).isolated === true) return { ...base, status: "ready", message: "监听 " + addresses.join("、") + "；有效防火墙策略阻止入站。策略变化后需重新检查。" };
    return { ...base, status: "error", message: "OBS 监听 " + addresses.join("、") + "，尚未证实防火墙隔离。请在 Windows 防火墙限制此 OBS 的入站访问，不要开放公网端口。" };
  } catch { return { ...base, status: "error", message: "无法验证实际监听或防火墙策略，请在 Windows 中核查；不能据此认定仅本机可访问。" }; }
}
