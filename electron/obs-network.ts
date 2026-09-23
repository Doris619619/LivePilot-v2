/** 读取实际 TCP 监听和 Windows 防火墙有效策略；连接 loopback 不等于仅本机监听。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../src/core/config";
import { ObsProcessManager } from "../src/core/obs/process";
import { ObsController } from "../src/core/obs/controller";
import { isAppError, safeError } from "../src/core/errors";
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
  const base = { id: "network-" + item.id, instanceId: item.id, checkedAt: Date.now(), label: item.name + " 连接与网络" };
  try {
    const read=()=>config(item.id);const proc=await new ObsProcessManager(read).inspect();
    if(proc.portPid && proc.portPid!==proc.pid)return {...base,status:"error",code:"port-conflict",action:item.managed?"repair":"help",message:`端口 ${item.port} 被其他进程（PID ${proc.portPid}）占用。请先关闭 ${item.name}，再修复连接；不会结束占用端口的程序。`};
    if(!proc.pid)return {...base,status:"pending",code:"not-running",action:"launch",message:`${item.name} 尚未启动。点击“启动并检查”，只启动程序，不会开播。`};
    if(!proc.portPid)return {...base,status:"error",code:"not-listening",action:item.managed?"repair":"help",message:`${item.name} 已运行，但端口 ${item.port} 未监听。在该 OBS 的“工具 → WebSocket 服务器设置”检查是否启用。自动修复前请先关闭此 OBS。`};
    const controller=new ObsController(read);
    try {await controller.call("GetVersion");} catch(e){return {...base,status:"error",code:isAppError(e)?e.code:"connection-unknown",action:item.managed?"repair":"help",message:safeError(e)+" 请在对应 OBS 的“工具 → WebSocket 服务器设置”核对；自动修复前先关闭 OBS。"};} finally {await controller.disconnect();}
    const network = await exec("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const addresses = listeningAddresses(network.stdout, item.port);
    if (!addresses.length) return { ...base, status: "pending", code: "listener-changed", action: "retry", message: "检查期间监听状态发生变化，请重新检查。" };
    if (loopbackOnly(addresses)) return { ...base, status: "ready", message: "实际监听仅限本机：" + addresses.join("、") };
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", firewallQuery], { windowsHide: true, timeout: 25_000, env: { ...process.env, LN_OBS_EXE: item.exe, LN_OBS_PORT: String(item.port) } });
    if (JSON.parse(result.stdout).isolated === true) return { ...base, status: "ready", message: "监听 " + addresses.join("、") + "；有效防火墙策略阻止入站。策略变化后需重新检查。" };
    return { ...base, status: "error", code: "firewall-unconfirmed", action: "firewall", message: "OBS 监听 " + addresses.join("、") + "，尚未证实防火墙隔离。请在 Windows 防火墙限制此 OBS 的入站访问，不要开放公网端口。" };
  } catch (e) { return { ...base, status: "pending", code: isAppError(e) ? e.code : "inspection-unavailable", action: "retry", message: isAppError(e) ? safeError(e) : "暂时无法完成此项检查。请重新检查，仍失败时查看对应电脑的检查步骤。" }; }
}
