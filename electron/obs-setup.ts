/** 初始化自有便携 OBS；重复操作保留已有场景和设置，绝不自动推流。 */
import { mkdir, readFile, writeFile, access, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { config, configureCore } from "../src/core/config";
import { ObsController } from "../src/core/obs/controller";
import { ObsProcessManager } from "../src/core/obs/process";
import { LocalObsRuntime } from "../src/core/obs/runtime";
import type { DesktopInstance } from "../src/shared/desktop";
import { environment, type Settings } from "./settings";
const exec = promisify(execFile);
/** 即使尚未配对云端，也必须确认本机实例没有推流/录制后才能维护。 */
export async function assertLocalIdle(settings: Settings) {
  configureCore(() => environment(settings));
  for (const instance of settings.instances) {
    if (!await access(instance.exe).then(() => true, () => false)) { if (instance.initialized) throw new Error(instance.name + " 的运行文件缺失，无法确认状态。"); continue; }
    const read = () => config(instance.id); const status = await new ObsProcessManager(read).inspect();
    if (status.portPid && status.portPid !== status.pid) throw new Error(instance.name + " 的端口被占用，无法确认状态，请处理后重试。");
    if (!status.pid) continue;
    const controller = new ObsController(read);
    try { if ((await controller.call("GetStreamStatus")).outputActive || (await controller.call("GetRecordStatus")).outputActive) throw new Error(instance.name + " 正在推流或录制，请结束后重试。"); }
    finally { await controller.disconnect(); }
  }
}
/** 寻找实际空闲端口，不停止占用端口的程序。 */
export async function freePort(excluded: number[], start = 4455): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    if (excluded.includes(port)) continue;
    const free = await new Promise<boolean>(resolve => { const server = createServer(); server.once("error", () => resolve(false)); server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error("没有找到空闲 OBS 端口，请处理端口占用后重试。");
}
/** 生成身份后先持久化，解压失败仍可用相同密码继续。 */
export async function newInstance(settings: Settings): Promise<DesktopInstance> {
  const id = settings.instances.some(i => i.id === "main" && i.initialized) ? "obs_" + randomBytes(4).toString("hex") : "main";
  return { id, name: settings.instances.length ? "OBS " + (settings.instances.length + 1) : "主 OBS", managed: true, exe: path.join(settings.dataRoot, "obs", id, "bin", "64bit", "obs64.exe"), port: await freePort(settings.instances.map(i => i.port)), password: randomBytes(24).toString("hex"), initialized: false };
}
/** 仅生成缺失的默认文件，已有配置保持不变。 */
async function seed(filename: string, value: string) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value, { flag: "wx" }).catch(e => { if (e.code !== "EEXIST") throw e; }); }
/** 区分安装包资源与手动 OBS 路径；提前报可操作错误，不等待 WebSocket 超时。 */
export async function requireObsFile(filename: string, message: string) {
  try { if (!(await stat(filename)).isFile()) throw new Error(); await access(filename); }
  catch { throw new Error(message); }
}
/** 解压固定官方包，便携配置不影响用户其他 OBS。 */
export async function prepareFiles(instance: DesktopInstance, resources: string, report: (stage: string) => void = () => {}) {
  if (!instance.managed) { await requireObsFile(instance.exe, "找不到手动选择的 obs64.exe，或没有读取权限。请恢复该专用 OBS；电脑未安装 OBS 时可撤销此候选，再点击“自动准备 OBS”，无需预装。"); return; }
  report("正在准备独立 OBS 目录");
  const root = path.resolve(instance.exe, "../../..");
  const extracted = await access(path.join(root, ".extracted")).then(() => true, () => false);
  if (!extracted) await requireObsFile(path.join(resources, "vendor", "obs.zip"), "安装包内置 OBS 资源缺失或不可读，请重新安装完整 LiveNest 安装包后重试。无需另行安装 OBS，已有配置会保留。");
  await mkdir(root, { recursive: true });
  const owner = path.join(root, ".livenest-owner");
  try { if (await readFile(owner, "utf8") !== instance.id) throw new Error("OBS 目录归属不匹配。"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; if ((await readdir(root)).length) throw new Error("OBS 目录已有其他文件，拒绝自动接管，请选择独立数据目录。"); await writeFile(owner, instance.id, { flag: "wx" }); }
  if (!extracted) {
    report("正在解压 OBS（首次准备可能需要几分钟）");
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LN_OBS_ZIP -DestinationPath $env:LN_OBS_ROOT -Force"], { windowsHide: true, timeout: 180_000, env: { ...process.env, LN_OBS_ZIP: path.join(resources, "vendor", "obs.zip"), LN_OBS_ROOT: root } }).catch(e => { throw new Error(e.killed ? "OBS 解压超过 3 分钟，请检查磁盘空间、目录权限和系统负载后重试。" : "OBS 解压失败，请检查数据目录权限、磁盘空间及安装包是否完整后重试。"); });
    await requireObsFile(instance.exe, "OBS 解压未完成，未找到 obs64.exe。请检查安装包完整性、磁盘空间和安全软件拦截记录后重试；候选配置已保留。");
    await writeFile(path.join(root, ".extracted"), "32.2.2");
  }
  await requireObsFile(instance.exe, "已配置的便携 OBS 程序缺失或不可读，请恢复原目录中的 obs64.exe，并检查安全软件拦截记录。为保护原场景和授权，没有覆盖已有 OBS。");
  report("正在写入场景、音频和连接配置");
  await seed(path.join(root, "portable_mode.txt"), ""); const base = path.join(root, "config", "obs-studio");
  await seed(path.join(base, "global.ini"), "[General]\nFirstRun=false\nEnableAutoUpdates=false\n[Basic]\nProfile=LiveNest\nProfileDir=LiveNest\nSceneCollection=LiveNest\nSceneCollectionFile=LiveNest\n");
  // OBS 32 将用户选择移至 user.ini；只写 global.ini 会打开默认场景并启用全局音频。
  await seed(path.join(base, "user.ini"), "[General]\nFirstRun=true\n[Basic]\nProfile=LiveNest\nProfileDir=LiveNest\nSceneCollection=LiveNest\nSceneCollectionFile=LiveNest.json\nConfigOnNewProfile=false\n");
  await seed(path.join(base, "basic", "profiles", "LiveNest", "basic.ini"), "[General]\nName=LiveNest\n[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1280\nOutputCY=720\nFPSType=0\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=4000\nABitrate=128\nStreamEncoder=x264\nPreset=veryfast\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n");
  await seed(path.join(base, "basic", "scenes", "LiveNest.json"), JSON.stringify({ name: "LiveNest", current_scene: "LIVE", current_program_scene: "LIVE", scene_order: [{ name: "LIVE" }], sources: [{ name: "LIVE", id: "scene", settings: { items: [] } }], groups: [], transitions: [], quick_transitions: [], saved_projectors: [] }));
  await seed(path.join(base, "plugin_config", "obs-websocket", "config.json"), JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_port: instance.port, server_password: instance.password }));
}
/** 启动后通过真实 WebSocket 创建标准媒体源，人工 OBS 只做检查。 */
export async function initializeObs(settings: Settings, instance: DesktopInstance, resources: string, report: (stage: string) => void = () => {}) {
  await prepareFiles(instance, resources, report); configureCore(() => environment(settings));
  const read = () => config(instance.id); const controller = new ObsController(read, { id: instance.id, scene: "LIVE", video: "VIDEO", music: "MUSIC" });
  try {
    report("正在启动 OBS 并检查端口 " + instance.port + "（连接检查最多约 60 秒）");
    await new LocalObsRuntime(controller, new ObsProcessManager(read)).ensureReady();
    report("正在检查场景和媒体源");
    if (!instance.managed || instance.initialized) { await controller.validate(); return; }
    if ((await controller.call("GetStreamStatus")).outputActive || (await controller.call("GetRecordStatus")).outputActive) throw new Error("OBS 正在推流或录制，请结束后再配置。");
    const scenes = await controller.call("GetSceneList"); if (!scenes.scenes.some(s => s.sceneName === "LIVE")) await controller.call("CreateScene", { sceneName: "LIVE" });
    const inputs = await controller.call("GetInputList");
    for (const name of ["VIDEO", "MUSIC"]) {
      if (!inputs.inputs.some(i => i.inputName === name)) await controller.call("CreateInput", { sceneName: "LIVE", inputName: name, inputKind: "ffmpeg_source", inputSettings: { is_local_file: true, looping: true, restart_on_activate: true, close_when_inactive: false }, sceneItemEnabled: true });
      await controller.call("SetInputAudioMonitorType", { inputName: name, monitorType: "OBS_MONITORING_TYPE_NONE" });
      await controller.call("SetInputMute", { inputName: name, inputMuted: name === "VIDEO" });
    }
    const item = await controller.call("GetSceneItemId", { sceneName: "LIVE", sourceName: "VIDEO" });
    await controller.call("SetSceneItemTransform", { sceneName: "LIVE", sceneItemId: item.sceneItemId, sceneItemTransform: { boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1920, boundsHeight: 1080, positionX: 0, positionY: 0, alignment: 5 } });
    await controller.call("SetCurrentProgramScene", { sceneName: "LIVE" }); await controller.validate();
  } finally { await controller.disconnect(); }
}
