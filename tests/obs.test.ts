/** OBS v5 协议、媒体音频控制和实例配置注入的模拟回归测试。 */
import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ call: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), on: vi.fn() }));
vi.mock("obs-websocket-js", () => ({ default: class { call = fake.call; connect = fake.connect; disconnect = fake.disconnect; on = fake.on; } }));
import { config } from "@/server/config";
import { ObsController } from "@/server/obs/controller";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("LIVEPILOT_OBS_WS_PASSWORD", "private-password"); fake.connect.mockResolvedValue({}); fake.disconnect.mockResolvedValue(undefined); fake.call.mockImplementation(async name => name === "GetSceneItemId" ? { sceneItemId: 1 } : name === "GetMediaInputStatus" ? { mediaState: "OBS_MEDIA_STATE_PLAYING" } : {}); });
it("uses WebSocket v5, loops both sources and applies the VIDEO audio toggle", async () => {
  const controller = new ObsController();
  await controller.configureMedia("D:/video.mp4", "D:/music.mp3", false);
  expect(fake.connect).toHaveBeenCalledWith("ws://127.0.0.1:4455", "private-password", { rpcVersion: 1, eventSubscriptions: 0 });
  expect(fake.call).toHaveBeenCalledWith("SetInputSettings", { inputName: "VIDEO", inputSettings: { is_local_file: true, local_file: "D:/video.mp4", looping: true, restart_on_activate: true, close_when_inactive: false }, overlay: true });
  expect(fake.call).toHaveBeenCalledWith("SetInputMute", { inputName: "VIDEO", inputMuted: true });
  expect(fake.call).toHaveBeenCalledWith("SetInputMute", { inputName: "MUSIC", inputMuted: false });
  await controller.configureMedia("D:/video.mp4", "D:/music.mp3", true);
  expect(fake.call).toHaveBeenCalledWith("SetInputMute", { inputName: "VIDEO", inputMuted: false });
});
it("sanitizes OBS errors containing passwords or stream keys", async () => {
  const controller = new ObsController(); fake.call.mockRejectedValue(new Error("private-password secret-key"));
  await expect(controller.configureStream("rtmps://host/live", "secret-key")).rejects.toThrow("SetStreamServiceSettings");
  try { await controller.configureStream("rtmps://host/live", "secret-key"); } catch (e) { expect(String(e)).not.toMatch(/private-password|secret-key/); }
});
it("rejects a missing LIVE scene", async () => {
  const controller = new ObsController();
  fake.call.mockImplementation(async name => name === "GetSceneList" ? { scenes: [] } : { inputs: [] });
  await expect(controller.validate()).rejects.toThrow("缺少 LIVE");
});


/** 三个控制器分别使用自己的端口和密码；不连接真实 OBS。 */
it("connects three controllers with independent instance settings", async () => {
  const base = config();
  for (const [id, port] of [["main", 4456], ["obs_a", 4455], ["studio_c", 4457]] as const) {
    const controller = new ObsController(() => ({ ...base, wsUrl: "ws://127.0.0.1:" + port, wsPort: port, obsPassword: id + "-password" }), { id, scene: "LIVE", video: "VIDEO", music: "MUSIC" });
    await controller.connect();
    expect(controller.instance.id).toBe(id);
    expect(fake.connect).toHaveBeenCalledWith("ws://127.0.0.1:" + port, id + "-password", { rpcVersion: 1, eventSubscriptions: 0 });
  }
  expect(fake.connect).toHaveBeenCalledTimes(3);
});
