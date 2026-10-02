/** 我的发布的纯汇总：按频道组织批次，只用当前修订的真实报告证明公开或完成。 */
import type { PublishingPlan, VideoJob } from "@/shared/publishing";

export type OverviewTarget = { agentId: string; instanceId: string; name: string; channelId?: string; channel?: string };
export type PublicationBucket = "published" | "completed" | "pending" | "attention" | "cancelled";
export type PublicationCounts = Record<PublicationBucket, number> & { total: number; scheduled: number; paused: number; pausePending: number; cancelPending: number; excluded: number; budgetWaiting: number };
export type PublishingOverviewBatch = { key: string; name: string; plan?: PublishingPlan; jobs: VideoJob[]; counts: PublicationCounts; next?: { instant: string; timezone: string }; state: string; tone: "normal" | "success" | "warning" | "error" };
export type PublishingOverviewChannel = { id: string; name: string; device?: string; batches: PublishingOverviewBatch[] };

/** 自动预算等候使用结构化标记；旧记录只兼容唯一固定文案，不能把其他阻塞误判为可自动恢复。 */
export function publicationBudgetWaiting(job: VideoJob) {
  return job.budgetWaiting === true || job.blockReason === "等待项目发布预算及太平洋时间配额日重置。";
}

/** published 是 Runner 在真实 public 回读后持久化的执行事实，API 观察字段过期不撤销它；仍须当前修订确认。 */
export function publicationBucket(job: VideoJob): PublicationBucket {
  const report = job.observed;
  if (report?.revision === job.spec.revision) {
    if (report.state === "cancelled") return "cancelled";
    if (report.state === "published" || report.state === "completed" && report.observedPrivacy === "public") return "published";
    if (job.spec.profile.privacy !== "public" && report.state === "completed") return "completed";
    if (["needs_attention", "failed"].includes(report.state)) return "attention";
  }
  return job.blockReason && !publicationBudgetWaiting(job) ? "attention" : "pending";
}

/** 互斥计数保留未收到任务的已确认项；暂停只认当前 paused 报告，未确认控制意图仍属于待发布。 */
export function publicationCounts(jobs: VideoJob[], plan?: PublishingPlan): PublicationCounts {
  const counts: PublicationCounts = { total: 0, published: 0, completed: 0, pending: 0, attention: 0, cancelled: 0, scheduled: 0, paused: 0, pausePending: 0, cancelPending: 0, excluded: plan?.items.filter(item => item.excluded).length || 0, budgetWaiting: 0 };
  for (const job of jobs) {
    const bucket = publicationBucket(job); counts[bucket]++; counts.total++;
    if (bucket !== "pending") continue;
    if (publicationBudgetWaiting(job)) counts.budgetWaiting++;
    const current = job.observed?.revision === job.spec.revision;
    if (current && job.observed?.state === "scheduled") counts.scheduled++;
    if (current && job.observed?.state === "paused") counts.paused++;
    else if (job.spec.desired === "pause") counts.pausePending++;
    if (job.spec.desired === "cancel") counts.cancelPending++;
  }
  const missing = Math.max(0, (plan?.items.filter(item => !item.excluded).length || 0) - jobs.length);
  counts.total += missing; counts.pending += missing;
  return counts;
}

/** 下一条使用远端生效时间优先；保留过期项供核对，不把过去时刻当作完成。 */
export function nextPublication(jobs: VideoJob[]) {
  return jobs.filter(job => ["pending", "attention"].includes(publicationBucket(job)) && job.spec.profile.privacy === "public")
    .map(job => ({ instant: job.observed?.effectivePublishAt || job.spec.originalPublishAt, timezone: job.spec.plan?.timezone || job.spec.profile.schedule.timezone }))
    .filter((item): item is { instant: string; timezone: string } => !!item.instant && Number.isFinite(Date.parse(item.instant)))
    .sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant))[0];
}

/** 一个简短批次状态归纳最需要客户关注的结果；到时未公开只能等待核对。 */
function batchState(counts: PublicationCounts, plan: PublishingPlan | undefined, next: ReturnType<typeof nextPublication>, now: number): Pick<PublishingOverviewBatch, "state" | "tone"> {
  if (plan?.archivedAt) return { state: "已归档", tone: "success" };
  if (plan?.archivePending) return { state: "归档待确认", tone: "warning" };
  if (counts.attention) return { state: "需要处理", tone: "error" };
  if (counts.cancelPending) return { state: "取消待确认", tone: "warning" };
  if (counts.pausePending) return { state: "暂停待确认", tone: "warning" };
  if (counts.paused) return { state: counts.paused === counts.pending ? "本地已暂停" : "部分本地已暂停", tone: "warning" };
  if (!counts.pending) return { state: counts.cancelled ? counts.published + counts.completed ? "已结束" : "已取消" : "全部完成", tone: "success" };
  if (counts.budgetWaiting) return { state: "等待预算/配额", tone: "warning" };
  if (next && Date.parse(next.instant) <= now) return { state: "等待公开确认", tone: "warning" };
  if (counts.published) return { state: "发布正常", tone: "success" };
  return { state: counts.scheduled ? "自动发布中" : "自动准备中", tone: "normal" };
}

/** 权限已由 Cloud 过滤；此处跨设备按不可变目标频道汇总，旧扁平批次也保留入口。 */
export function publishingOverview(plans: PublishingPlan[], jobs: VideoJob[], targets: OverviewTarget[], now: number): PublishingOverviewChannel[] {
  const groups = new Map<string, PublishingOverviewChannel>();
  const planIds = new Set(plans.map(plan => plan.id));
  const jobsByBatch = new Map<string, VideoJob[]>();
  for (const job of jobs) { const group = jobsByBatch.get(job.spec.batchId) || []; group.push(job); jobsByBatch.set(job.spec.batchId, group); }
  /** 当前绑定的可读名称只标识频道，不改变旧任务固定的目标身份。 */
  function add(profile: VideoJob["spec"]["profile"], key: string, name: string, batchJobs: VideoJob[], plan?: PublishingPlan) {
    const exact = targets.find(target => target.channelId === profile.channelId && target.agentId === profile.agentId && target.instanceId === profile.instanceId);
    const target = exact || targets.find(value => value.channelId === profile.channelId);
    let group = groups.get(profile.channelId);
    if (!group) { group = { id: profile.channelId, name: target?.channel || profile.channelId, device: exact?.name, batches: [] }; groups.set(profile.channelId, group); }
    const counts = publicationCounts(batchJobs, plan); const next = nextPublication(batchJobs);
    group.batches.push({ key, name, plan, jobs: batchJobs, counts, next, ...batchState(counts, plan, next, now) });
  }
  for (const plan of [...plans].filter(plan => plan.confirmedAt).sort((a, b) => b.createdAt - a.createdAt)) add(plan.profile, plan.id, plan.batch.name, jobsByBatch.get(plan.id) || [], plan);
  for (const [id, batchJobs] of jobsByBatch) if (!planIds.has(id)) add(batchJobs[0].spec.profile, "legacy:" + id, "视频任务 · " + batchJobs[0].spec.profile.name, batchJobs);
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
