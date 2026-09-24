/** 读取实际 TCP 监听和 Windows 防火墙有效策略；连接 loopback 不等于仅本机监听。 */
import { config } from "../src/core/config";
import { ObsProcessManager } from "../src/core/obs/process";
import { ObsController } from "../src/core/obs/controller";
import { isAppError, safeError } from "../src/core/errors";
import type { Check, DesktopInstance } from "../src/shared/desktop";
import { inspectFirewall } from "./obs-firewall";
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
/** 权限不足、策略含糊或开放接口均显式报待核查，不将它们解释为安全。 */
export async function checkObsNetwork(item: DesktopInstance): Promise<Check> {
  const base = { id: "network-" + item.id, instanceId: item.id, checkedAt: Date.now(), label: item.name + " 连接与网络", controlReady: false };
  try {
    const read=()=>config(item.id);const proc=await new ObsProcessManager(read).inspect();
    if(proc.portPid && proc.portPid!==proc.pid)return {...base,status:"error",code:"port-conflict",action:item.managed?"repair":"help",message:`端口 ${item.port} 被其他进程（PID ${proc.portPid}）占用。请先关闭 ${item.name}，再修复连接；不会结束占用端口的程序。`};
    if(!proc.pid)return {...base,status:"pending",code:"not-running",action:"launch",message:`${item.name} 尚未启动。点击“启动并检查”，只启动程序，不会开播。`};
    if(!proc.portPid)return {...base,status:"error",code:"not-listening",action:item.managed?"repair":"help",message:`${item.name} 已运行，但端口 ${item.port} 未监听。在该 OBS 的“工具 → WebSocket 服务器设置”检查是否启用。自动修复前请先关闭此 OBS。`};
    const controller=new ObsController(read);
    try {await controller.call("GetVersion");} catch(e){return {...base,status:"error",code:isAppError(e)?e.code:"connection-unknown",action:item.managed?"repair":"help",message:safeError(e)+" 请在对应 OBS 的“工具 → WebSocket 服务器设置”核对；自动修复前先关闭 OBS。"};} finally {await controller.disconnect();}
    // 已验证的控制连接独立于后续隔离检查，未配对时也能展示本机检查结果。
    base.controlReady = true; base.checkedAt = Date.now();
    inspectFirewall(item);
    return { ...base, status: "ready", message: "控制已连接。" };
  } catch (e) { return { ...base, status: "pending", code: isAppError(e) ? e.code : "inspection-unavailable", action: "retry", message: isAppError(e) ? safeError(e) : "暂时无法完成此项检查。请重新检查，仍失败时查看对应电脑的检查步骤。" }; }
}
