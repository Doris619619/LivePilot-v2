/** 本地界面登录：主进程校验密码摘要，会话只驻留内存，不影响 Agent。 */
import { scryptSync, timingSafeEqual } from "node:crypto";
const credential = { salt: "774d9900bfff44d36ab15c44d99e7858", hash: "d3bed107de3bbb0ec0bdbdd80fa7676778788ee0bca7ad28f47e7995e011d53c" };
export class DesktopAuth {
  private authenticated = false; private failures = 0; private blockedUntil = 0;
  /** 仅返回界面会话状态，不暴露摘要或配置。 */
  session() { return { authenticated: this.authenticated }; }
  /** 限制失败重试；密码不经过 Renderer 持久化、命令行或日志。 */
  login(username: unknown, password: unknown) {
    if (Date.now() < this.blockedUntil) return { ok: false, message: "尝试次数过多，请一分钟后重试。" };
    const validInput = typeof username === "string" && typeof password === "string" && username.length <= 80 && password.length <= 256;
    const validPassword = validInput && timingSafeEqual(scryptSync(password as string, credential.salt, 32), Buffer.from(credential.hash, "hex"));
    if (!validPassword || username !== "Do") {
      this.failures++; if (this.failures >= 5) { this.blockedUntil = Date.now() + 60_000; this.failures = 0; }
      return { ok: false, message: "账号或密码不正确。" };
    }
    this.authenticated = true; this.failures = 0; this.blockedUntil = 0; return { ok: true };
  }
  /** 退出仅撤销界面会话，不停止后台服务。 */
  logout() { this.authenticated = false; }
  /** 每一次配置读取和写操作都必须经过主进程授权。 */
  require() { if (!this.authenticated) throw new Error("请先登录 LiveNest。"); }
}
