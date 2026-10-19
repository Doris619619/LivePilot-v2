/** 读取实际 TCP 监听和 Windows 防火墙有效策略；连接 loopback 不等于仅本机监听。 */
import { config } from "../src/core/config";
import { ObsProcessManager } from "../src/core/obs/process";
import { ObsController } from "../src/core/obs/controller";
import { AppError, isAppError, safeError } from "../src/core/errors";
import type { Check, DesktopInstance } from "../src/shared/desktop";
import { OBS_DIAGNOSIS_TIMEOUT_MS, type ObsStartupProgress } from "../src/shared/obs-startup";
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
type DiagnosisOptions = { report?: (progress: ObsStartupProgress) => void };
/** 单次只读复查可报告真实阶段；单参数重载保留 Array.map(checkObsNetwork) 的调用兼容性。 */
export function checkObsNetwork(item: DesktopInstance, options: DiagnosisOptions): Promise<Check>;
export function checkObsNetwork(item: DesktopInstance): Promise<Check>;
/** 总预算覆盖进程、端口与 WebSocket 读取；到期取消系统查询，迟到结果不能再推进检查。 */
export async function checkObsNetwork(item: DesktopInstance, options: DiagnosisOptions = {}): Promise<Check> {
  const base = { id: "network-" + item.id, instanceId: item.id, label: item.name + " 连接与网络", controlReady: false };
  const deadlineAt = Date.now() + OBS_DIAGNOSIS_TIMEOUT_MS;
  const cancellation = new AbortController();
  let active = true;
  let controller: ObsController | undefined;
  let progress: ObsStartupProgress = { phase: "process", deadlineAt, probeCount: 0 };
  /** 只读复查超时不启动或关闭 OBS，也不将旧连接结论当成本轮成功。 */
  const timeout = () => new AppError("OBS_DIAGNOSIS_TIMEOUT", "本次控制连接检查已超时，当前状态尚未确认。请重新检查；不会启动或关闭 OBS。", 504);
  /** 每次异步完成后先核对预算，避免旧查询继续连接或发布成功。 */
  function guard() { if (!active || Date.now() >= deadlineAt) throw timeout(); }
  /** 阶段切换和实际观测分开；只有已完成的探测才更新最后观测时刻。 */
  function publish(phase: ObsStartupProgress["phase"], observation?: string) {
    guard();
    progress = { ...progress, phase, ...(observation && { observation, lastProbeAt: Date.now(), probeCount: progress.probeCount + 1 }) };
    options.report?.(progress);
  }
  /** 关闭本轮独立控制连接；清理不阻塞截止结算，迟到建连后仍会再次断开。 */
  function disconnect() { if (controller) void controller.disconnect().catch(() => {}); }
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { active = false; cancellation.abort(); disconnect(); reject(timeout()); }, OBS_DIAGNOSIS_TIMEOUT_MS);
  });
  /** 不调用 ensureRunning 或写请求，仅确认进程、控制连接和 GetVersion 响应。 */
  async function inspectOnce(): Promise<Check> {
    try {
      publish("process");
      const read = () => config(item.id);
      const proc = await new ObsProcessManager(read).inspect(cancellation.signal); guard();
      if (proc.portPid && proc.portPid !== proc.pid) {
        publish("process", "控制端口由其他进程占用，尚未确认此 OBS 的控制连接。");
        return { ...base, checkedAt: Date.now(), status: "error", code: "port-conflict", action: item.managed ? "repair" : "help", message: `端口 ${item.port} 被其他进程（PID ${proc.portPid}）占用。请先关闭 ${item.name}，再修复连接；不会结束占用端口的程序。` };
      }
      if (!proc.pid) {
        publish("process", "尚未检测到此 OBS 进程；本次复查不会启动程序。");
        return { ...base, checkedAt: Date.now(), status: "pending", code: "not-running", action: "launch", message: `${item.name} 尚未启动。点击“启动并检查”，只启动程序，不会开播。` };
      }
      if (!proc.portPid) {
        publish("process", "OBS 已运行，但控制端口尚未监听。");
        return { ...base, checkedAt: Date.now(), status: "error", code: "not-listening", action: item.managed ? "repair" : "help", message: `${item.name} 已运行，但端口 ${item.port} 未监听。在该 OBS 的“工具 → WebSocket 服务器设置”检查是否启用。自动修复前请先关闭此 OBS。` };
      }
      publish("control", "已确认 OBS 进程与控制端口，正在连接控制服务。");
      controller = new ObsController(read);
      await controller.connect(); guard();
      publish("verify", "控制服务已回应，正在读取 OBS 版本状态。");
      await controller.call("GetVersion"); guard();
      publish("ready", "已读取 OBS 版本并确认控制连接；未执行启动或开播操作。");
      // 防火墙是独立后台观测，不参与当前控制连接的成功结算。
      inspectFirewall(item);
      return { ...base, checkedAt: Date.now(), controlReady: true, status: "ready", message: "控制已连接。" };
    } finally { disconnect(); }
  }
  try { return await Promise.race([inspectOnce(), expired]); }
  catch (e) {
    const expired = isAppError(e) && e.code === "OBS_DIAGNOSIS_TIMEOUT";
    const connection = progress.phase !== "process" && !expired;
    return { ...base, checkedAt: Date.now(), status: connection ? "error" : "pending", code: isAppError(e) ? e.code : connection ? "connection-unknown" : "inspection-unavailable", action: connection ? item.managed ? "repair" : "help" : "retry", message: connection ? safeError(e) + " 请在对应 OBS 的“工具 → WebSocket 服务器设置”核对；自动修复前先关闭 OBS。" : isAppError(e) ? safeError(e) : "暂时无法完成此项检查。请重新检查，仍失败时查看对应电脑的检查步骤。" };
  } finally { active = false; clearTimeout(timer!); cancellation.abort(); disconnect(); }
}
