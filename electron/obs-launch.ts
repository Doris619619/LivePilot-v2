/** 只启动指定的已配置 OBS 并读取控制状态；不创建实例、修改场景或开始输出。 */
import { config, configureCore } from "../src/core/config";
import { AppError } from "../src/core/errors";
import { ObsController } from "../src/core/obs/controller";
import { ObsProcessManager } from "../src/core/obs/process";
import { Store } from "../src/core/storage";
import { environment, type Settings } from "./settings";
import { inspectFirewall } from "./obs-firewall";
import { connectObsForDesktop } from "./obs-startup";
import { obsStartupLabels, type ObsStartupProgress } from "../src/shared/obs-startup";
import type { Check } from "../src/shared/desktop";

/** 与 Agent 共用目标实例控制锁；其他实例的直播和配置不参与启动条件。 */
export async function launchObs(settings: Settings, id: string, report: (stage: string, progress: ObsStartupProgress) => void): Promise<Check> {
  const item = settings.instances.find(instance => instance.id === id);
  if (!item?.initialized) throw new AppError("OBS_CONFIG", "请选择已配置的 OBS；待配置实例请先完成准备。");
  if (settings.maintenance || settings.inventoryPending) throw new AppError("DESKTOP_BUSY", "设备配置调整尚未完成，请先重新连接并恢复，再启动 OBS。");
  configureCore(() => environment(settings));
  const target = config(item.id); const read = () => target;
  const controller = new ObsController(read);
  await new Store(target.dataDir).exclusive(() => connectObsForDesktop(new ObsProcessManager(read), controller, progress => report(obsStartupLabels[progress.phase], progress)));
  // 控制已由同一轮读请求确认，不再重连一次；防火墙保留为独立后台检查。
  inspectFirewall(item);
  return { id: "network-" + item.id, instanceId: item.id, label: item.name + " 控制连接", status: "ready", controlReady: true, checkedAt: Date.now(), message: "控制已连接。" };
}
