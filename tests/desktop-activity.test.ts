/** 操作反馈必须可跨页面恢复，重试清除旧错误但保留真实起始时间。 */
import { expect, it, vi } from "vitest";
import { Activity } from "../electron/activity";
it("retains failure stage and replaces it on retry without exposing inputs", () => {
  vi.useFakeTimers();
  try {
    const activity = new Activity(); activity.begin("prepare"); const startedAt = activity.value!.startedAt;
    vi.advanceTimersByTime(65_000); activity.progress("主 OBS · 等待连接"); activity.fail("端口被占用");
    expect(activity.value).toEqual({ action: "prepare", step: 2, status: "failed", stage: "主 OBS · 等待连接", startedAt, message: "端口被占用" });
    activity.progress("迟到的进度"); expect(activity.value!.stage).toContain("等待连接");
    activity.begin("repair"); expect(activity.value!.step).toBe(2); expect(activity.value!.message).toBeUndefined(); expect(activity.value!.startedAt).toBeGreaterThan(startedAt);
    activity.complete(); expect(activity.value!.status).toBe("complete");
  } finally { vi.useRealTimers(); }
});
