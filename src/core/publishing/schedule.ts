/** 使用 Temporal 明确处理 IANA 时区、夏令时跳时和重叠；计划确认后保存 UTC。 */
import { Temporal } from "@js-temporal/polyfill";
import type { PublishingProfile } from "@/shared/publishing";
import { AppError } from "../errors";
export type ScheduleSlot = { publishAt: string; local: string; overlapping: boolean };
/** 从开始日期生成未来时刻；不存在的本地时间跳过，重叠时间选较早一次。 */
export function scheduleSlots(rule: PublishingProfile["schedule"], count: number, now = Date.now()) {
  let day: Temporal.PlainDate;
  try { day = Temporal.PlainDate.from(rule.startDate); } catch { throw new AppError("INPUT", "排期开始日期无效。"); }
  const slots: ScheduleSlot[] = []; const skipped: string[] = [];
  const [hour, minute] = rule.localTime.split(":").map(Number);
  for (let n = 0; slots.length < count && n < 3660; n++, day = day.add({ days: 1 })) {
    if (!rule.weekdays.includes(day.dayOfWeek)) continue;
    const plain = day.toPlainDateTime({ hour, minute });
    const first = plain.toZonedDateTime(rule.timezone, { disambiguation: "earlier" });
    const last = plain.toZonedDateTime(rule.timezone, { disambiguation: "later" });
    if (!first.toPlainDateTime().equals(plain)) { skipped.push(plain.toString()); continue; }
    if (first.epochMilliseconds <= now) continue;
    slots.push({ publishAt: first.toInstant().toString(), local: plain.toString(), overlapping: first.epochMilliseconds !== last.epochMilliseconds });
  }
  if (slots.length !== count) throw new AppError("INPUT", "无法在十年内生成完整排期，请检查开始日期和规则。");
  return { slots, skipped };
}
/** 已错过的时刻使用当前策略提前量，不顺延其他任务。 */
export function effectivePublishAt(original: string, lead: number, now = Date.now()) { return new Date(Math.max(Date.parse(original), now + lead * 1000)).toISOString(); }
/** 配额日以太平洋时间为准，夏令时由 Temporal 处理。 */
export function quotaDay(now = Date.now()) { return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("America/Los_Angeles").toPlainDate().toString(); }
