/** 本地可信窗口专用更新入口；不返回实例、目录、配对身份或配置状态。 */
import { z } from "zod";
import { problemFor } from "../src/core/errors";
import type { DesktopAction, DesktopState, LocalUpdateResult, LocalUpdateState } from "../src/shared/desktop";
type Host = { busy: boolean; updates: { state: DesktopState["update"] }; act(action: DesktopAction): Promise<DesktopState> };
const command = z.enum(["update-check", "update-download", "update-install"]);
export class UpdateAccess {
  /** 依赖仅限本机更新协调器；不会调用云端账号或设备权限接口。 */
  constructor(private host: Host, private version: () => string) {}
  /** 明确构造最小 DTO；不使用完整状态的展开运算。 */
  state(): LocalUpdateState { return { version: this.version(), busy: this.host.busy, update: this.host.updates.state }; }
  /** 与配置共用宿主串行锁；拒绝任意非更新命令。 */
  async act(action: unknown): Promise<LocalUpdateResult> {
    try {
      const result = await this.host.act(command.parse(action));
      const problem = this.host.updates.state.problem;
      const cancelled = result.activity?.status === "cancelled";
      return { ok: cancelled || !problem, state: this.state(), cancelled, ...(!cancelled && problem ? { problem } : {}) };
    } catch (error) { return { ok: false, state: this.state(), problem: problemFor(error) }; }
  }
}
