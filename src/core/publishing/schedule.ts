/** 使用 Temporal 明确处理 IANA 时区、夏令时跳时和重叠；计划确认后保存 UTC。 */
import { Temporal } from "@js-temporal/polyfill";
import type { PublishingProfile, PublishingPlanRule, VideoJob } from "@/shared/publishing";
import { AppError } from "../errors";
export type ScheduleSlot = { publishAt: string; local: string; overlapping: boolean };
/** 从开始日期生成未来时刻；不存在的本地时间跳过，重叠时间选较早一次。 */
export function scheduleSlots(rule: PublishingProfile["schedule"], count: number, now = Date.now()) {
  return schedulePlanSlots({ timezone: rule.timezone, startDate: rule.startDate, weeklySlots: rule.weekdays.map(weekday => ({ weekday, time: rule.localTime })), preuploadDays: rule.preuploadDays }, count, [], now);
}
/** 多星期、多时刻排期按本地日期排序；已占用的 UTC 时刻与 DST 缺口均不会产生任务。 */
export function schedulePlanSlots(rule: PublishingPlanRule, count: number, occupied: Iterable<number> = [], now = Date.now()) {
  let day: Temporal.PlainDate;
  try { day = Temporal.PlainDate.from(rule.startDate); } catch { throw new AppError("INPUT", "排期开始日期无效。"); }
  const slots: ScheduleSlot[] = []; const skipped: string[] = [];
  const used = new Set(occupied); let skippedOccupied = 0;
  const weekly = [...new Map(rule.weeklySlots.map(slot => [slot.weekday + ":" + slot.time, slot])).values()].sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time));
  for (let n = 0; slots.length < count && n < 3660; n++, day = day.add({ days: 1 })) {
    for (const slot of weekly.filter(slot => slot.weekday === day.dayOfWeek)) {
      if (slots.length >= count) break;
      const [hour, minute] = slot.time.split(":").map(Number); const plain = day.toPlainDateTime({ hour, minute });
      const first = plain.toZonedDateTime(rule.timezone, { disambiguation: "earlier" });
      const last = plain.toZonedDateTime(rule.timezone, { disambiguation: "later" });
      if (!first.toPlainDateTime().equals(plain)) { skipped.push(plain.toString()); continue; }
      if (first.epochMilliseconds <= now) continue;
      if (used.has(first.epochMilliseconds)) { skippedOccupied++; continue; }
      used.add(first.epochMilliseconds); slots.push({ publishAt: first.toInstant().toString(), local: plain.toString(), overlapping: first.epochMilliseconds !== last.epochMilliseconds });
    }
  }
  if (slots.length !== count) throw new AppError("INPUT", "无法在十年内生成完整排期，请检查开始日期和规则。");
  return { slots, skipped, skippedOccupied };
}
/** 暂停、结果未知和待取消继续占位；只有当前取消修订已被 Agent 确认才释放。 */
export function occupiedPublishingSlots(jobs: VideoJob[], channelId: string, excluding?: string) {
  const occupied = new Set<number>();
  for (const job of jobs) {
    if (job.spec.id === excluding || job.spec.profile.channelId !== channelId || job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision) continue;
    for (const at of [job.spec.originalPublishAt, job.observed?.effectivePublishAt, job.pendingPublishAt]) if (at && Number.isFinite(Date.parse(at))) occupied.add(Date.parse(at));
  }
  return occupied;
}
/** 已错过的时刻使用当前策略提前量，不顺延其他任务。 */
export function effectivePublishAt(original: string, lead: number, now = Date.now()) { return new Date(Math.max(Date.parse(original), now + lead * 1000)).toISOString(); }
/** 配额日以太平洋时间为准，夏令时由 Temporal 处理。 */
export function quotaDay(now = Date.now()) { return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("America/Los_Angeles").toPlainDate().toString(); }
