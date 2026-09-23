/** 宿主保留操作阶段；不会保存表单、密码或配对信息。 */
import { randomUUID } from "node:crypto";
import type { Problem } from "../src/shared/problems";
import { activityStep, type DesktopAction, type DesktopActivity } from "../src/shared/desktop";
export class Activity {
  value?: DesktopActivity;
  /** 新操作覆盖旧提示，起始时间由宿主提供。 */
  begin(action: DesktopAction, instanceId?: string) { this.value = { action, instanceId, attemptId:randomUUID(), step: activityStep(action), status: "running", stage: "正在检查操作条件", startedAt: Date.now() }; }
  /** 结束后忽略迟到的阶段报告。 */
  progress(stage: string) { if (this.value?.status === "running") this.value = { ...this.value, stage }; }
  /** 完成后让页面回到常规检查结果。 */
  complete() { if (this.value?.status === "running") this.value = { ...this.value, status: "complete" }; }
  /** 调用方先过滤错误；保留失败时的阶段供就地修复。 */
  fail(message: string, problem?: Problem) { if (this.value) this.value = { ...this.value, status: "failed", message, problem }; }
  /** 用户取消选择不显示成功，也不清空待修正输入。 */
  cancel() { if(this.value)this.value={...this.value,status:"cancelled"}; }
}
