/** 桌面状态与操作共用绑定边界，删除确认失败时绝不清空本机身份。 */
import { AppError, problemFor } from "../src/core/errors";
import type { DesktopResult } from "../src/shared/desktop";
import type { DesktopAuth } from "./auth";
import type { Manager } from "./manager";
export class DesktopAccess {
  private checking?: Promise<void>;
  private checkedId?: string;
  private checkedUser?: string;
  private checkedAt = 0;
  constructor(private auth: DesktopAuth, private manager: Manager) {}
  /** 轮询最多缓存十秒，写操作强制重验；删除只在受信服务明确确认后生效。 */
  async require(fresh = true) {
    if (this.checking) await this.checking;
    const identity = this.manager.settings.identity;
    const user = this.auth.session();
    if (!identity || !this.manager.settings.paired) return this.auth.require();
    if (!fresh && user.authenticated && this.checkedUser === user.username && this.checkedId === identity.agentId && Date.now() - this.checkedAt < 10000) return;
    this.checking = (async () => {
      const status = await this.auth.binding(identity);
      if (status === "deleted") await this.manager.forgetBinding(identity.agentId);
      this.checkedId = this.manager.settings.identity?.agentId; this.checkedUser = user.username; this.checkedAt = Date.now();
    })();
    try { await this.checking; if (!this.auth.session().authenticated || this.auth.session().username !== user.username) throw new AppError("AUTH", "登录已变化，请重新读取状态。", 401); } finally { this.checking = undefined; }
  }
  /** 失败结构化返回，前端能区分权限、登录、服务和本机保存错误。 */
  async read(): Promise<DesktopResult> {
    try { await this.require(false); return { ok: true, state: this.manager.state() }; }
    catch (e) { return { ok: false, problem: problemFor(e, { source: "desktop", stage: "读取本机状态", outcome: "rejected" }) }; }
  }
  /** 本机删除先在云端撤销，结果丢失可重复确认；不隐式停止 OBS。 */
  async remove() {
    await this.require();
    const identity = this.manager.settings.identity;
    if (!identity || !this.manager.settings.paired) return;
    if (this.manager.busy) throw new AppError("DESKTOP_BUSY", "当前操作尚未完成，请完成后再删除设备。");
    await this.manager.forgetBinding(identity.agentId, () => this.auth.binding(identity, true));
    this.checkedAt = 0;
  }
}
