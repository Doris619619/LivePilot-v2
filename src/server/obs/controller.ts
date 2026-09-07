/** 每个控制器只连接一个 OBS WebSocket，管理固定 LIVE / VIDEO / MUSIC。 */
import "server-only";
import OBSWebSocket from "obs-websocket-js";
import type { OBSRequestTypes, OBSResponseTypes } from "obs-websocket-js";
import { config } from "../config";
import { AppError, waitFor } from "../errors";
export type ObsInstance = { id: string; scene: "LIVE"; video: "VIDEO"; music: "MUSIC" };
const standard: ObsInstance = { id: "main", scene: "LIVE", video: "VIDEO", music: "MUSIC" };
export class ObsController {
  private socket = new OBSWebSocket();
  private connected = false;
  private connecting?: Promise<void>;
  /** 绑定实例配置及连接失效事件；每个控制器持有自己的 Socket。 */
  constructor(private readConfig = config, readonly instance: ObsInstance = standard) {
    this.socket.on("ConnectionClosed", () => { this.connected = false; });
    this.socket.on("ConnectionError", () => { this.connected = false; });
  }
  /** 去重当前实例的连接尝试，超时后清理 Socket，不转发含凭据的原始错误。 */
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = this.readConfig();
      if (!c.obsPassword) throw new AppError("CONFIG", "请在 .env.local 配置 OBS WebSocket 密码。");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.socket.connect(c.wsUrl, c.obsPassword, { rpcVersion: 1, eventSubscriptions: 0 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 5000); }),
        ]);
        this.connected = true;
      } catch {
        await this.socket.disconnect().catch(() => {});
        throw new AppError("OBS_CONNECT", "无法连接 OBS WebSocket。请检查 OBS、WebSocket v5 端口及密码。");
      } finally { clearTimeout(timer); }
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  /** 发送 v5 请求并限时确认；错误消息仅包含请求名。 */
  async call<T extends keyof OBSRequestTypes>(name: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T]> {
    await this.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.socket.call(name, data),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 8000); }),
      ]);
    } catch {
      // Never propagate OBS's raw error/request: it can include paths or stream credentials.
      throw new AppError("OBS_REQUEST", "OBS " + name + " 未能确认成功。请检查 OBS 状态；可通过结束直播恢复。");
    } finally { clearTimeout(timer); }
  }
  /** 严格校验受控场景与音频边界，避免混入额外采集源。 */
  async validate() {
    const scenes = await this.call("GetSceneList");
    const inputs = await this.call("GetInputList");
    if (!scenes.scenes.some(s => s.sceneName === this.instance.scene)) throw new AppError("OBS_SCENE", "OBS 缺少 LIVE 场景。请按 README 创建 LIVE 和两个媒体源 VIDEO / MUSIC。");
    const items = await this.call("GetSceneItemList", { sceneName: this.instance.scene });
    for (const name of [this.instance.video, this.instance.music]) {
      const input = inputs.inputs.find(i => i.inputName === name);
      if (!input || input.unversionedInputKind !== "ffmpeg_source" || !items.sceneItems.some(i => i.sourceName === name)) {
        throw new AppError("OBS_SCENE", "LIVE 中缺少标准媒体源 " + name + "。请使用 OBS 的“媒体源”，不要使用 VLC 源。");
      }
    }
    // A dedicated scene must contain exactly the two managed sources.
    if (items.sceneItems.length !== 2) throw new AppError("OBS_SCENE", "LIVE 仅允许 VIDEO / MUSIC 两个直接媒体源，请移除其他场景项。");
    const special = await this.call("GetSpecialInputs");
    if (Object.values(special).some(Boolean)) throw new AppError("OBS_AUDIO", "请在专用 OBS 的设置 → 音频中禁用全局桌面音频与麦克风，防止混入未选择的声音。");
  }
  /** 设置两个本地媒体源、循环和原声，并确认 OBS 已实际开始播放。 */
  async configureMedia(video: string, music: string, videoAudio: boolean) {
    for (const [inputName, file] of [[this.instance.video, video], [this.instance.music, music]]) {
      await this.call("SetInputSettings", { inputName, inputSettings: { is_local_file: true, local_file: file, looping: true, restart_on_activate: true, close_when_inactive: false }, overlay: true });
      await this.call("SetInputAudioMonitorType", { inputName, monitorType: "OBS_MONITORING_TYPE_NONE" });
      await this.call("SetInputAudioTracks", { inputName, inputAudioTracks: { "1": true, "2": true, "3": true, "4": true, "5": true, "6": true } });
      await this.call("SetInputVolume", { inputName, inputVolumeMul: 1 });
      const item = await this.call("GetSceneItemId", { sceneName: this.instance.scene, sourceName: inputName });
      await this.call("SetSceneItemEnabled", { sceneName: this.instance.scene, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
    }
    await this.call("SetInputMute", { inputName: this.instance.video, inputMuted: !videoAudio });
    await this.call("SetInputMute", { inputName: this.instance.music, inputMuted: false });
    await this.call("SetCurrentProgramScene", { sceneName: this.instance.scene });
    for (const inputName of [this.instance.video, this.instance.music]) {
      await this.call("TriggerMediaInputAction", { inputName, mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART" });
      await waitFor(async () => {
        const status = await this.call("GetMediaInputStatus", { inputName });
        if (status.mediaState === "OBS_MEDIA_STATE_ERROR") throw new AppError("OBS_MEDIA", inputName + " 无法解码所选媒体，请在 OBS 检查文件。");
        return status;
      }, status => status.mediaState === "OBS_MEDIA_STATE_PLAYING", inputName + " 未开始播放，已停止后续开播步骤。", 15_000, 500);
    }
  }
  /** 仅接受有效 RTMPS 推流参数，在服务端设置到所属 OBS。 */
  async configureStream(server: string, key: string) {
    if (!server.startsWith("rtmps://") || !key) throw new AppError("INGEST", "YouTube 未返回有效的 RTMPS 推流参数。");
    await this.call("SetStreamServiceSettings", { streamServiceType: "rtmp_custom", streamServiceSettings: { server, key, use_auth: false } });
  }
}
