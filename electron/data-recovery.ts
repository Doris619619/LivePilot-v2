/** 启动前的原生数据恢复界面：只读诊断、重试和核验原数据，不生成身份或启动 OBS。 */
import { safeError } from "../src/core/errors";
import type { SettingsStore } from "./settings";
export type RecoveryInterface = {
  choose(message: string, location: string): Promise<"retry" | "locate" | "copy" | "quit">;
  locate(): Promise<string | undefined>;
  confirm(location: string): Promise<boolean>;
  copy(value: string): void;
};
/** 读盘失败停留在恢复对话框；只有 init 成功后调用方才建立普通工作窗口。 */
export async function initializeWithRecovery(init: () => Promise<void>, store: SettingsStore, ui: RecoveryInterface): Promise<boolean> {
  let failure: unknown;
  for (;;) {
    try { await init(); return true; } catch (error) { failure = error; }
    for (;;) {
      const location = await store.recoveryLocation().catch(() => "原数据位置记录不可读取");
      const message = safeError(failure);
      const action = await ui.choose(message, location);
      if (action === "quit") return false;
      if (action === "copy") { ui.copy("LiveNest 数据恢复\n原数据位置：" + location + "\n" + message); continue; }
      if (action === "retry") break;
      const target = await ui.locate(); if (!target) continue;
      try {
        const verified = await store.inspectRecovery(target);
        if (!await ui.confirm(verified.dataRoot)) continue;
        await store.restoreLocation(target); break;
      } catch (error) { failure = error; }
    }
  }
}
