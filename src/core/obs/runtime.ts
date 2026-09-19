/** 本地运行核心：供 Windows Agent 和本地控制台共同使用。 */
import type { ObsStatus } from "@/shared/types";
import { ObsController } from "./controller";
import { ObsProcessManager } from "./process";
import { AppError, safeError, sleep } from "../errors";
// Agent 和本地模式共享该本机控制契约；云端发送完整任务，不逐条转发 OBS 调用。
export interface ObsRuntime {
  status(): Promise<ObsStatus>;
  ensureReady(): Promise<void>;
  validate(): Promise<void>;
  setMedia(video: string, music: string, videoAudio: boolean): Promise<void>;
  setStream(server: string, key: string): Promise<void>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
}
export class LocalObsRuntime implements ObsRuntime {
  constructor(private controller = new ObsController(), private processManager = new ObsProcessManager()) {}
  async status(): Promise<ObsStatus> {
    let running = false;
    try {
      const process = await this.processManager.inspect();
      running = !!process.pid;
      if (!running) return { ready: false, running, streaming: false, message: "OBS 未运行" };
      if (process.portPid !== process.pid) throw new AppError("OBS_PORT", "OBS WebSocket 尚未就绪，或端口不属于指定 OBS。");
      const version = await this.controller.call("GetVersion");
      const scene = await this.controller.call("GetCurrentProgramScene");
      const stream = await this.controller.call("GetStreamStatus");
      return { ready: true, running, streaming: stream.outputActive, reconnecting: stream.outputReconnecting, durationMs: stream.outputDuration, scene: scene.currentProgramSceneName, version: version.obsVersion };
    } catch (e) { return { ready: false, running, streaming: null, message: safeError(e) }; }
  }
  async ensureReady() {
    await this.processManager.ensureRunning();
    const deadline = Date.now() + 60_000;
    let reason = "尚未收到 OBS 响应";
    do {
      const status = await this.status();
      if (status.ready) return;
      reason = status.message || reason;
      await sleep(1500);
    } while (Date.now() < deadline);
    throw new AppError("OBS_READY", "OBS 连接检查超时。最后检查结果：" + reason + "。请查看 OBS 窗口或配置图解，处理后重试。");
  }
  async validate() { await this.controller.validate(); }
  async setMedia(video: string, music: string, audio: boolean) { await this.controller.configureMedia(video, music, audio); }
  async setStream(server: string, key: string) { await this.controller.configureStream(server, key); }
  async startStream() { await this.controller.call("StartStream"); }
  async stopStream() { await this.controller.call("StopStream"); }
}
