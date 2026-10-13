/** 批次删除的设备与执行反馈；只读取现有 DTO，不把受理或投递编号当作取消成功。 */
import type { PublishingBatchRemoval, VideoJob } from "@/shared/publishing";
import type { AgentDescriptor } from "@/shared/remote";
export type PublishingDevice = Pick<AgentDescriptor, "id" | "online" | "maintenance">;
export type RemovalFeedback = { state: string; message: string; tone: "warning" | "error" | "success" };

/** 当前真实完成项无需等待设备；缺失或旧修订的报告仍属于未确认，不推断远端取消。 */
function removalUnconfirmed(job: VideoJob) {
  const report = job.observed;
  if (!report || report.revision !== job.spec.revision || report.authorizationInvalid) return true;
  if (report.state === "published") return false;
  if (report.state === "cancelled") return report.observedPrivacy === "public";
  return !(report.state === "completed" && (report.observedPrivacy === "public" || !job.spec.profile.scheduled && ["private", "unlisted"].includes(job.spec.profile.privacy)));
}

/** 真实异常优先保留原因；只有明确 false 才称离线，未读取设备状态沿用待确认。 */
export function publishingRemovalFeedback(removal: PublishingBatchRemoval | undefined, jobs: VideoJob[], devices?: PublishingDevice[], agentId?: string): RemovalFeedback | undefined {
  if (!removal) return undefined;
  if (removal.completedAt) return { state: "已移出总览", message: "已移出总览，视频和素材保留。", tone: "success" };
  const unconfirmed = jobs.filter(removalUnconfirmed);
  const failed = unconfirmed.find(job => job.observed?.revision === job.spec.revision && (job.observed.authorizationInvalid || ["failed", "needs_attention", "completed", "cancelled", "published"].includes(job.observed.state)));
  if (failed) return { state: "删除需处理", message: failed.observed!.message || "取消结果未确认，请查看详情核对。", tone: "error" };
  const ids = new Set(unconfirmed.map(job => job.spec.profile.agentId)); if (!ids.size && agentId) ids.add(agentId);
  const targets = devices?.filter(device => ids.has(device.id));
  if (targets?.some(device => device.online === false)) return { state: "等待设备上线", message: "设备离线，打开这台电脑的 LiveNest 后会继续删除。", tone: "warning" };
  if (targets?.some(device => device.maintenance === true)) return { state: "等待维护结束", message: "设备正在维护，完成后会继续删除。", tone: "warning" };
  if (unconfirmed.some(job => job.observed?.revision === job.spec.revision && job.observed.state === "retry_wait")) return { state: "取消等待重试", message: "取消等待重试，设备会继续处理。", tone: "warning" };
  if (unconfirmed.some(job => job.spec.desired === "cancel" && job.observed?.revision === job.spec.revision)) return { state: "正在取消", message: "正在取消，等待设备确认。", tone: "warning" };
  return { state: "删除待确认", message: "删除待确认。未确认前，已排期的视频仍可能公开。", tone: "warning" };
}
