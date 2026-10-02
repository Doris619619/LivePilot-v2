/** 发布历史的显示与筛选：复用原任务和快照，只整理已观察到的终态事实。 */
import { publishingTerminal, type PublishingPlan, type VideoJob } from "@/shared/publishing";
import type { OverviewTarget } from "./publishing-overview";

export type HistoryResult = "published" | "completed" | "cancelled" | "failed";
export type HistoryRow = { job: VideoJob; title: string; batch: string; channel: string; result: HistoryResult; resultLabel: string; plannedAt?: string; timezone: string; recordedAt: number };
export const historyResultLabels: Record<HistoryResult, string> = { published: "已公开", completed: "已完成", cancelled: "已取消", failed: "失败" };

/** API 文案过期后仍可用用户确认的内容；不把未生成的 AI 或模板结果伪装成最终标题。 */
function historyTitle(job: VideoJob, plan?: PublishingPlan) {
  const packageId = job.spec.contentPackage?.id;
  const copy = packageId && plan?.copies.find(value => value.packageId === packageId);
  return job.observed?.metadata?.title || job.spec.overrides.title || (copy ? copy.title : "") || job.spec.contentPackage?.title || job.spec.contentPackage?.name || job.spec.asset.filename;
}

/** 保留旧修订的终态观察，新的指令是否确认由详情单独说明，不抹去已公开的事实。 */
export function publishingHistory(plans: PublishingPlan[], jobs: VideoJob[], targets: OverviewTarget[]): HistoryRow[] {
  const byPlan = new Map(plans.map(plan => [plan.id, plan]));
  return jobs.filter(job => publishingTerminal(job.observed?.state)).map(job => {
    const report = job.observed!; const plan = byPlan.get(job.spec.batchId);
    const target = targets.find(value => value.channelId === job.spec.profile.channelId && value.agentId === job.spec.profile.agentId && value.instanceId === job.spec.profile.instanceId) || targets.find(value => value.channelId === job.spec.profile.channelId);
    const result: HistoryResult = report.state === "completed" && report.observedPrivacy === "public" ? "published" : report.state as HistoryResult;
    return { job, title: historyTitle(job, plan), batch: plan?.batch.name || job.spec.contentPackage?.batchName || job.spec.profile.name, channel: target?.channel || job.spec.profile.channelId, result, resultLabel: historyResultLabels[result], plannedAt: report.effectivePublishAt || job.spec.originalPublishAt, timezone: job.spec.plan?.timezone || job.spec.profile.schedule.timezone, recordedAt: report.updatedAt || job.createdAt };
  }).sort((a, b) => b.recordedAt - a.recordedAt || b.job.createdAt - a.job.createdAt || a.title.localeCompare(b.title, "zh-CN", { numeric: true }) || a.job.spec.id.localeCompare(b.job.spec.id));
}

/** 对整份授权内历史做搜索和结果筛选后再分页，搜索包含可读频道及发布包名称。 */
export function filterHistory(rows: HistoryRow[], query: string, result: HistoryResult | "") {
  const search = query.trim().toLocaleLowerCase("zh-CN");
  return rows.filter(row => (!result || row.result === result) && (!search || [row.title, row.batch, row.channel, row.job.spec.contentPackage?.name || "", row.job.spec.asset.filename].join("\n").toLocaleLowerCase("zh-CN").includes(search)));
}

/** 只格式化已保存的时刻；列标题必须明确区分计划时间与真实发布结果。 */
export function historyTime(instant: string | number | undefined, timezone: string) {
  if (instant === undefined) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}
