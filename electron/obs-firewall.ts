/** 托管 OBS 防火墙保护与后台诊断；固定脚本提权，不执行用户提供的命令。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Check, DesktopInstance } from "../src/shared/desktop";
import type { Settings } from "./settings";
import { ordinaryEntry, ordinaryPath, readRoot } from "./data-root";
const exec = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const cache = new Map<string, { at: number; check?: Check; running: boolean }>();
/** 缓存键包含真实程序和端口，配置变更不会复用旧结论。 */
function key(item: DesktopInstance) { return item.exe.toLowerCase() + ":" + item.port; }
/** 返回固定脱敏技术结论；不把无法检查解释为配置失败。 */
function report(item: DesktopInstance, message: string, ready = false): Check { return { id: "security-" + item.id, instanceId: item.id, label: "OBS 本机保护", status: ready ? "ready" : "pending", code: "firewall-unconfirmed", message, checkedAt: Date.now() }; }
/** 只读探测监听和有效规则，不阻塞控制连接，不在后台弹 UAC。 */
export function inspectFirewall(item: DesktopInstance, force = false) {
  const id = key(item); const old = cache.get(id);
  if (old?.running || (!force && old && Date.now() - old.at < 300_000)) return;
  const entry = { at: Date.now(), running: true, check: old?.check }; cache.set(id, entry);
  const script = String.raw`$ErrorActionPreference='Stop'
$profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore)
$valid=$profiles.Count -eq 3 -and @($profiles|Where-Object { -not $_.Enabled -or $_.AllowLocalFirewallRules -eq 'False' }).Count -eq 0
$rules=@(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Inbound -Enabled True -Action Block | Where-Object {$_.Group -like 'LiveNest-Control-*'})
$found=$false
foreach($rule in $rules){
 $app=$rule|Get-NetFirewallApplicationFilter; $port=$rule|Get-NetFirewallPortFilter; $address=$rule|Get-NetFirewallAddressFilter
 if($app.Program -ieq $env:LN_OBS_EXE -and $port.Protocol -in @('TCP','6') -and @($port.LocalPort).Count -eq 1 -and $port.LocalPort -eq $env:LN_OBS_PORT -and $rule.Profile -eq 'Any'){
  $expected=@('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
  if(@(Compare-Object @($address.RemoteAddress) $expected).Count -eq 0){$found=$true}
 }
}
@{isolated=($valid -and $found)}|ConvertTo-Json -Compress`;
  void exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, LN_OBS_EXE: item.exe, LN_OBS_PORT: String(item.port) } }).then(result => {
    const isolated = JSON.parse(result.stdout).isolated === true;
    entry.check = report(item, isolated ? "已核对有效的本机控制端口保护规则。" : "本机保护策略尚未确认；此项不代表控制连接或推流失败。", isolated);
  }).catch(() => { entry.check = report(item, "防火墙技术检查暂不可用；控制连接单独检查。"); }).finally(() => { entry.running = false; entry.at = Date.now(); });
}
/** 公开缓存快照；未完成的后台检查不会被伪装成成功。 */
export function firewallChecks(items: DesktopInstance[]) { return items.flatMap(item => { const value = cache.get(key(item))?.check; return value ? [value] : []; }); }
/** 配置清单指纹用于每次明确配置变更最多请求一次授权。 */
export function firewallFingerprint(settings: Settings) { return createHash("sha256").update(JSON.stringify([settings.rootId, settings.instances.filter(i => i.managed && i.initialized).map(i => [i.id, i.exe, i.port])])).digest("hex"); }
/** 固定辅助脚本重新读取 DPAPI 配置、归属及路径，提权只执行精确端口限制。 */
export async function protectObs(settings: Settings, resources: string) {
  const items = settings.instances.filter(i => i.managed && i.initialized);
  if (!items.length) return;
  try {
    const root = await ordinaryPath(settings.dataRoot); const marker = await readRoot(root);
    if (marker.id !== settings.rootId) throw new Error();
    for (const item of items) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(item.id) || !Number.isInteger(item.port) || item.port < 1024 || item.port > 65535) throw new Error();
      const expected = path.join(root, "obs", item.id, "bin", "64bit", "obs64.exe");
      if ((await ordinaryEntry(item.exe)).toLowerCase() !== (await ordinaryEntry(expected)).toLowerCase()) throw new Error();
      if (await readFile(path.join(root, "obs", item.id, ".livenest-owner"), "utf8") !== item.id) throw new Error();
    }
    const helper = await ordinaryEntry(path.join(resources, "helpers", "obs-firewall.ps1"));
    const root64 = Buffer.from(root).toString("base64");
    const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" -Root64 ${root64} -RootId ${marker.id}`;
    const script = "$ErrorActionPreference='Stop'; try {$p=Start-Process -FilePath '" + powershell.replaceAll("'", "''") + "' -ArgumentList '" + args.replaceAll("'", "''") + "' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode} catch {exit 2}";
    await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 });
    items.forEach(item => { cache.delete(key(item)); inspectFirewall(item, true); });
  } catch {
    for (const item of items) cache.set(key(item), { at: Date.now(), running: false, check: report(item, "本机保护未确认完成（可能取消了系统授权或策略不允许）；直播控制不受此检查结论影响。") });
  }
}
