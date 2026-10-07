/** 对照全部可见上传历史提前识别重复素材；仅作展示，Cloud 仍在确认事务内最终校验。 */
import type { ContentPackage, PublishingPlanItem, PublishingProfile, VideoJob } from "@/shared/publishing";

export type UploadBlock = { packageId: string; name: string; reason: "published" | "uploaded" | "cancelling" | "unchanged" | "unconfirmed"; label: string; videoId?: string };
export type UploadReview = { blockers: UploadBlock[]; replacements: string[] };

/** 与 Cloud 按设备、频道、包 ID 匹配；移除批次或切换授权账号不抹掉旧上传证据。 */
export function publishingUploadReview(profile: Pick<PublishingProfile, "agentId" | "channelId">, packages: ContentPackage[], items: Pick<PublishingPlanItem, "packageId" | "excluded">[], jobs: VideoJob[]): UploadReview {
  const replacements: string[] = []; const blockers: UploadBlock[] = [];
  for (const item of items) {
    if (item.excluded) continue;
    const pkg = packages.find(value => value.id === item.packageId); if (!pkg) continue;
    const previous = jobs.filter(job => job.spec.profile.agentId === profile.agentId && job.spec.profile.channelId === profile.channelId && job.spec.contentPackage?.id === pkg.id);
    const blocked = previous.filter(job => {
      const cancelled = job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision;
      if (cancelled && job.spec.contentPackage?.version !== pkg.version) { replacements.push(job.spec.id); return false; }
      return !cancelled || !!job.hadUpload;
    });
    if (!blocked.length) continue;
    const old = blocked.find(job => job.observed?.state === "published") || blocked.find(job => job.spec.desired === "cancel" && job.observed?.revision !== job.spec.revision) || blocked[0];
    const reason = old.observed?.state === "published" ? "published" : old.spec.desired === "cancel" && (old.observed?.revision !== old.spec.revision || old.observed.state !== "cancelled") ? "cancelling" : old.observed?.state === "cancelled" ? "unchanged" : old.observed?.videoId || old.hadUpload ? "uploaded" : "unconfirmed";
    const labels = { published: "已在此频道公开", uploaded: "已有上传记录", cancelling: "取消尚未确认", unchanged: "已取消，素材仍是原版本", unconfirmed: "已有任务待核对" };
    blockers.push({ packageId: pkg.id, name: pkg.name, reason, label: labels[reason], videoId: old.observed?.videoId });
  }
  return { blockers, replacements };
}
