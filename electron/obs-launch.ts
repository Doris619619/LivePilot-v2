/** 只启动指定的已配置 OBS 并读取控制状态；不创建实例、修改场景或开始输出。 */
import { config, configureCore } from "../src/core/config";
import { AppError } from "../src/core/errors";
import { ObsController } from "../src/core/obs/controller";
import { ObsProcessManager } from "../src/core/obs/process";
import { LocalObsRuntime } from "../src/core/obs/runtime";
import { Store } from "../src/core/storage";
import { environment, type Settings } from "./settings";
import { checkObsNetwork } from "./obs-network";

/** 与 Agent 共用目标实例控制锁；其他实例的直播和配置不参与启动条件。 */
export async function launchObs(settings: Settings, id: string, report: (stage: string) => void) {
  const item = settings.instances.find(instance => instance.id === id);
  if (!item?.initialized) throw new AppError("OBS_CONFIG", "请选择已配置的 OBS；待配置实例请先完成准备。");
  if (settings.maintenance || settings.inventoryPending) throw new AppError("DESKTOP_BUSY", "设备配置调整尚未完成，请先重新连接并恢复，再启动 OBS。");
  configureCore(() => environment(settings));
  const target = config(item.id); const read = () => target;
  const controller = new ObsController(read);
  try {
    report(item.name + " · 正在启动并等待控制连接（最多约 60 秒）");
    await new Store(target.dataDir).exclusive(() => new LocalObsRuntime(controller, new ObsProcessManager(read)).ensureReady());
  } finally { await controller.disconnect(); }
  report(item.name + " · 控制已连接，正在核对网络状态");
  const check = await checkObsNetwork(item);
  if (!check.controlReady) throw new AppError("OBS_CONNECT", check.message || "OBS 已启动，但控制连接尚未确认。请重新检查此 OBS。");
  report(item.name + " · 已启动并确认控制连接；未执行开播操作");
  return check;
}
