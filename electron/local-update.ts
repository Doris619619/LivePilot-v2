/** 本机更新的安全边界：排空前后检查 OBS，不申请云端配置维护锁。 */
import { AppError, problemFor } from "../src/core/errors";
type LocalUpdate = { wasRunning: boolean; checkIdle(): Promise<void>; stop(): Promise<void>; flush(): Promise<void>; reconnect(): Promise<void>; install(prepare: () => Promise<void>): Promise<boolean> };
/** 二次检查防止排空中的任务刚好启动推流；失败只恢复原有 Agent，不改变 OBS。 */
export async function runLocalUpdate(target: LocalUpdate) {
  let stopped = false;
  try {
    return await target.install(async () => {
      await target.checkIdle(); await target.stop(); stopped = true;
      await target.checkIdle(); await target.flush();
    });
  } catch (error) {
    if (stopped && target.wasRunning) {
      try { await target.reconnect(); }
      catch {
        const original = problemFor(error);
        const message = original.message + " 另：Agent 连接未恢复，请在设备配置中重新连接；原配置已保留。";
        throw new AppError(original.code, message, 400, { ...original, message });
      }
    }
    throw error;
  }
}
