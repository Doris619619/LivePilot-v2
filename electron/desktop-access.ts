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
  private localStopAllowed = false;
  private checkedGeneration?: number;
  private checkedToken?: string;
  constructor(private auth: DesktopAuth, private manager: Manager) {}
  /** 轮询最多缓存十秒，写操作强制重验；删除只在受信服务明确确认后生效。 */
  async require(fresh = true) {
    if (this.checking) await this.checking;
    const identity = this.manager.settings.identity;
    const user = this.auth.session();
    const generation = this.auth.sessionGeneration();
    if (!identity || !this.manager.settings.paired) return this.auth.require();
    if (!fresh && user.authenticated && this.checkedUser === user.username && this.checkedId === identity.agentId && this.checkedToken === identity.token && this.checkedGeneration === this.auth.sessionGeneration() && Date.now() - this.checkedAt < 10000) return;
    this.checking = (async () => {
      const status = await this.auth.binding(identity);
      const current = this.manager.settings.identity;
      if (!this.auth.session().authenticated || this.auth.session().username !== user.username || this.auth.sessionGeneration() !== generation || current?.agentId !== identity.agentId || current?.token !== identity.token) throw new AppError("AUTH", "登录或设备已变化，请重新核验绑定。", 401);
      this.localStopAllowed = status === "active";
      this.checkedGeneration = generation; this.checkedToken = identity.token;
      if (status === "deleted") await this.manager.forgetBinding(identity.agentId);
      this.checkedId = this.manager.settings.identity?.agentId; this.checkedUser = user.username; this.checkedAt = Date.now();
    })();
    try { await this.checking; if (!this.auth.session().authenticated || this.auth.session().username !== user.username) throw new AppError("AUTH", "登录已变化，请重新读取状态。", 401); }
    catch (error) { if (error instanceof AppError && !["CLOUD_NETWORK", "CLOUD_UNAVAILABLE"].includes(error.code)) this.localStopAllowed = false; throw error; }
    finally { this.checking = undefined; }
  }
  /** 离线只读与停止共用本次登录/设备的既有授权，网络失败不授予新权限。 */
  private hasLocalAccess() {
    const user = this.auth.session(), identity = this.manager.settings.identity;
    return user.authenticated && this.localStopAllowed && !!identity && !!this.manager.settings.paired && this.checkedId === identity.agentId && this.checkedToken === identity.token && this.checkedGeneration === this.auth.sessionGeneration() && this.checkedUser === user.username && this.manager.agent.errorCode !== "AGENT_AUTH";
  }
  /** 仅已核对过当前登录与本机绑定时可离线停止，不授予其他离线控制权限。 */
  async stopLocal(instanceId: string) {
    const user = this.auth.session();
    if (!user.authenticated) throw new AppError("AUTH", "登录已失效，请重新登录后使用本机停止。", 401);
    if (!this.hasLocalAccess()) throw new AppError("FORBIDDEN", "尚未验证当前账号与这台电脑的绑定，请联网核对后使用本机停止。", 403);
    return this.manager.stopLocal(instanceId);
  }
  /** 失败结构化返回，前端能区分权限、登录、服务和本机保存错误。 */
  async read(): Promise<DesktopResult> {
    try { await this.require(false); return { ok: true, state: this.manager.state() }; }
    catch (e) {
      const local = e instanceof AppError && ["CLOUD_NETWORK", "CLOUD_UNAVAILABLE"].includes(e.code) && this.hasLocalAccess();
      return { ok: false, problem: problemFor(e, { source: "desktop", stage: "读取本机状态", outcome: "rejected" }), ...(local ? { localState: this.manager.state() } : {}) };
    }
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
