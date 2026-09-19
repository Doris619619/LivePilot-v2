/** 本地登录拒绝未授权读写、异常输入及连续猜测，不涉及网页成员数据。 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DesktopAuth } from "../electron/auth";
afterEach(() => vi.useRealTimers());
describe("desktop local login", () => {
  it("starts locked and does not expose credentials", () => { const auth = new DesktopAuth(); expect(auth.session()).toEqual({ authenticated: false }); expect(() => auth.require()).toThrow("请先登录"); auth.logout(); expect(() => auth.require()).toThrow(); });
  it("rejects malformed input and wrong passwords", () => { const auth = new DesktopAuth(); for (const input of [undefined, {}, "a".repeat(257), "wrong"]) expect(auth.login("Do", input)).toEqual({ ok: false, message: "账号或密码不正确。" }); });
  it("limits guesses and allows retry after the cooldown", () => { vi.useFakeTimers(); const auth = new DesktopAuth(); for (let i = 0; i < 5; i++) auth.login("Do", "wrong"); expect(auth.login("Do", "wrong").message).toContain("一分钟"); vi.advanceTimersByTime(60_001); expect(auth.login("Do", "wrong").message).toContain("账号或密码"); });
});
