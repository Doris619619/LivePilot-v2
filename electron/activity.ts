/** 宿主保留操作阶段；不会保存表单、密码或配对信息。 */
import { randomUUID } from "node:crypto";
import type { Problem } from "../src/shared/problems";
import { activityStep, type DesktopAction, type DesktopActivity } from "../src/shared/desktop";
import type { ObsStartupProgress } from "../src/shared/obs-startup";
export class Activity {
  value?: DesktopActivity;
  readonly obsLaunches = new Map<string, DesktopActivity>();
  /** 每个实例只保留最近一次启动检查，后续只读复查不会抹去超时记录。 */
  private rememberLaunch() { if (this.value?.action === "launch-obs" && this.value.instanceId) this.obsLaunches.set(this.value.instanceId, this.value); }
  /** 新操作覆盖旧提示，起始时间由宿主提供。 */
  begin(action: DesktopAction, instanceId?: string) { this.value = { action, instanceId, attemptId:randomUUID(), step: activityStep(action), status: "running", stage: "正在检查操作条件", startedAt: Date.now() }; this.rememberLaunch(); }
  /** 结束后忽略迟到的阶段报告。 */
  progress(stage: string) { if (this.value?.status === "running") this.value = { ...this.value, stage }; }
  /** 进度只能写入对应启动轮次；旧异步回调不能覆盖下一轮。 */
  startup(attemptId: string, stage: string, progress: ObsStartupProgress) {
    if (this.value?.action !== "launch-obs" || this.value.attemptId !== attemptId || this.value.status !== "running") return;
    this.value = { ...this.value, stage, obsStartup: progress }; this.rememberLaunch();
  }
  /** 完成后让页面回到常规检查结果。 */
  complete() { if (this.value?.status === "running") { this.value = { ...this.value, status: "complete", endedAt: Date.now() }; this.rememberLaunch(); } }
  /** 调用方先过滤错误；保留失败时的阶段供就地修复。 */
  fail(message: string, problem?: Problem) { if (this.value) { this.value = { ...this.value, status: "failed", endedAt: Date.now(), message, problem }; this.rememberLaunch(); } }
  /** 用户取消选择不显示成功，也不清空待修正输入。 */
  cancel() { if(this.value)this.value={...this.value,status:"cancelled"}; }
}
