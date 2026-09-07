/** 验证热更新后仍能识别安全错误，同时禁止泄露伪造上游诊断。 */
import { expect, it, vi } from "vitest";
import { AppError, safeError, isAppError } from "@/server/errors";
/** 模块重载会改变 class 身份，但安全错误登记必须仍有效。 */
it("preserves safe errors across module reloads", async () => {
  const original = new AppError("OBS_PORT", "WebSocket 端口被占用", 409);
  vi.resetModules();
  const reloaded = await import("@/server/errors");
  expect(original instanceof reloaded.AppError).toBe(false);
  expect(reloaded.isAppError(original)).toBe(true);
  expect(reloaded.safeError(original)).toBe("WebSocket 端口被占用");
  expect(safeError(new reloaded.AppError("OBS_PATH", "路径不存在"))).toBe("路径不存在");
});
/** 形状类似 AppError 的对象与普通 Error 都不能向浏览器暴露 message。 */
it("rejects unregistered errors even when their fields look trusted", () => {
  for (const error of [{ code: "OBS_PORT", status: 409, message: "SECRET" }, Object.assign(new Error("SECRET"), { code: "OBS_PORT", status: 409 })]) {
    expect(isAppError(error)).toBe(false);
    expect(safeError(error)).not.toContain("SECRET");
  }
});
