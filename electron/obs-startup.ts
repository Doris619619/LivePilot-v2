/** 桌面启动检查：统一等待预算、真实阶段上报和可取消的只读探测，不发送开播或配置请求。 */
import { setTimeout as delay } from "node:timers/promises";
import type { ObsController } from "../src/core/obs/controller";
import type { ObsProcessManager } from "../src/core/obs/process";
import { AppError, isAppError, safeError } from "../src/core/errors";
import { OBS_STARTUP_TIMEOUT_MS, type ObsStartupProgress } from "../src/shared/obs-startup";

/** 预算覆盖进程检查、启动与控制确认；到期后禁止迟到结果推进阶段或触发新的启动。 */
export async function connectObsForDesktop(
  processManager: Pick<ObsProcessManager, "ensureRunning" | "inspect">,
  controller: Pick<ObsController, "connect" | "call" | "disconnect">,
  report: (progress: ObsStartupProgress) => void,
) {
  const deadlineAt = Date.now() + OBS_STARTUP_TIMEOUT_MS;
  const cancellation = new AbortController();
  let active = true;
  let progress: ObsStartupProgress = { phase: "process", deadlineAt, probeCount: 0 };
  /** 只返回本应用的安全诊断；停止的是检查，不声称 OBS 已退出。 */
  const timeout = () => new AppError("OBS_READY", "本轮连接检查已超时，尚未确认控制连接。OBS 可能仍在运行；请重新检查或查看连接帮助。", 504);
  /** 每个 await 后先检查预算，迟到的成功不能覆盖本轮超时。 */
  function guard() { if (!active || Date.now() >= deadlineAt) throw timeout(); }
  /** 只有实际完成的检查才更新观测时间；阶段切换本身不是心跳。 */
  function publish(phase: ObsStartupProgress["phase"], observation?: string) {
    guard();
    progress = { ...progress, phase, ...(observation && { observation, lastProbeAt: Date.now(), probeCount: progress.probeCount + 1 }) };
    report(progress);
  }
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { active = false; cancellation.abort(); reject(timeout()); }, OBS_STARTUP_TIMEOUT_MS);
  });
  /** 所有 OBS 请求均为只读；超时后即使底层 Promise 迟到，也不会继续请求或发布成功。 */
  async function inspectUntilReady() {
    try {
      publish("process");
      await processManager.ensureRunning(cancellation.signal); guard();
      while (true) {
        try {
          const process = await processManager.inspect(cancellation.signal); guard();
          if (process.portPid && process.portPid !== process.pid) throw new AppError("OBS_PORT", "此 OBS 的控制端口被其他程序占用，请核对连接设置。");
          if (!process.pid) publish("process", "尚未检测到 OBS 进程，正在等待程序启动。");
          else {
            publish("control", process.portPid ? "OBS 已运行，控制端口已就绪。" : "OBS 已运行，控制服务尚未就绪，正在继续检查。");
            if (process.portPid) {
              await controller.connect(); guard();
              publish("verify", "控制服务已回应，正在读取版本、场景与输出状态。");
              await controller.call("GetVersion"); guard();
              publish("verify", "已读取 OBS 版本，正在确认场景与输出状态。");
              await controller.call("GetCurrentProgramScene"); guard();
              publish("verify", "已读取当前场景，正在确认输出状态。");
              await controller.call("GetStreamStatus"); guard();
              publish("ready", "已确认 OBS 控制连接；未执行开播操作。");
              return;
            }
          }
        } catch (error) {
          guard();
          // 配置类问题需要处理；短暂建连或读取失败才重试。
          if (!isAppError(error) || !["OBS_CONNECT", "OBS_TIMEOUT", "OBS_READ", "OBS_INSPECT_TIMEOUT"].includes(error.code)) throw error;
          publish(progress.phase, safeError(error));
        }
        await delay(Math.min(1500, deadlineAt - Date.now()), undefined, { signal: cancellation.signal }); guard();
      }
    } finally {
      // 此控制器仅属于本轮检查，断开它不会停止 OBS 或其他 Agent 连接。
      void controller.disconnect();
    }
  }
  try { await Promise.race([inspectUntilReady(), expired]); }
  finally { active = false; clearTimeout(timer!); cancellation.abort(); void controller.disconnect(); }
}
