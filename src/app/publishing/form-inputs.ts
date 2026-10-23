/** 发布表单的文本提交与周时间更新；输入期间保留分隔符和当前控件顺序。 */
import type { PublishingPlanRule } from "@/shared/publishing";

/** 标签仅在提交时拆分，保留输入框内尚未完成的末尾逗号。 */
export function publishingTags(text: string): string[] { return text.split(",").map(value => value.trim()).filter(Boolean); }

/** 更新一个星期的时间而不按输入值重排；正在编辑的控件不会跳到另一个时刻。 */
export function replaceWeeklyTimes(rule: PublishingPlanRule, weekday: number, values: string[]): PublishingPlanRule {
  return { ...rule, weeklySlots: [...rule.weeklySlots.filter(slot => slot.weekday !== weekday), ...values.map(time => ({ weekday, time }))] };
}

/** URL 页码始终为非负安全整数；越界由组件按当前数据量钳制。 */
export function publishingPage(raw: string): number { const value = Number(raw); return Number.isSafeInteger(value) && value >= 0 ? value : 0; }

/** 只允许四步向导已有的步骤编号，实际可达性仍由当前计划判断。 */
export function publishingStep(raw: string): number { const value = Number(raw); return [1, 2, 3, 4].includes(value) ? value : 1; }

/** 月历只接受有效的四位年和月份；无效地址交由 URL hook 恢复当前月份。 */
export function publishingMonth(raw: string): string { if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error("月份无效"); return raw; }

/** 验证日期确实存在，避免外部链接把月历推进到二月三十日等非法日期。 */
export function publishingDate(raw: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw) throw new Error("日期无效"); return raw; }
