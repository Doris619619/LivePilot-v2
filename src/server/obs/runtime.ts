import "server-only";
import type { ObsStatus } from "@/shared/types";
import { ObsController } from "./controller";
import { ObsProcessManager } from "./process";
import { AppError, safeError, sleep } from "../errors";
// Future RemoteObsRuntime can implement this control-only contract. No Agent is implemented.
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
    do {
      const status = await this.status();
      if (status.ready) return;
      await sleep(1500);
    } while (Date.now() < deadline);
    throw new AppError("OBS_READY", "OBS 已尝试启动，但 WebSocket 在 60 秒内未就绪。请完成 OBS 首次设置、启用 WebSocket 并检查密码。");
  }
  async validate() { await this.controller.validate(); }
  async setMedia(video: string, music: string, audio: boolean) { await this.controller.configureMedia(video, music, audio); }
  async setStream(server: string, key: string) { await this.controller.configureStream(server, key); }
  async startStream() { await this.controller.call("StartStream"); }
  async stopStream() { await this.controller.call("StopStream"); }
}
