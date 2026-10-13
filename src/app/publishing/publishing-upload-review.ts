/** 区分已完成素材的主动再次发布和仍需核对的旧任务；Cloud 在确认事务内最终校验。 */
import { canRepublishPublishingJob, type ContentPackage, type PublishingPlanItem, type PublishingProfile, type VideoJob } from "@/shared/publishing";

export type UploadBlock = { packageId: string; name: string; reason: "published" | "uploaded" | "cancelling" | "unchanged" | "unconfirmed"; label: string; videoId?: string };
export type UploadRepeat = { packageId: string; name: string; jobIds: string[]; version: string; label: string; videoId?: string };
export type UploadReview = { blockers: UploadBlock[]; replacements: string[]; repeats: UploadRepeat[] };

/** 与 Cloud 按设备、频道、包 ID 匹配；移除批次或切换授权账号不抹掉旧上传证据。 */
export function publishingUploadReview(profile: Pick<PublishingProfile, "agentId" | "channelId">, packages: ContentPackage[], items: Pick<PublishingPlanItem, "packageId" | "excluded">[], jobs: VideoJob[], owner?: string): UploadReview {
  const replacements: string[] = []; const blockers: UploadBlock[] = []; const repeats: UploadRepeat[] = [];
  for (const item of items) {
    if (item.excluded) continue;
    const pkg = packages.find(value => value.id === item.packageId); if (!pkg) continue;
    const previous = jobs.filter(job => job.spec.profile.agentId === profile.agentId && job.spec.profile.channelId === profile.channelId && job.spec.contentPackage?.id === pkg.id);
    const completed = previous.filter(job => canRepublishPublishingJob(job) && (!owner || job.spec.owner === owner));
    const blocked = previous.filter(job => {
      if (completed.includes(job)) return false;
      const cancelled = job.observed?.state === "cancelled" && job.observed.revision === job.spec.revision;
      if (cancelled && job.spec.contentPackage?.version !== pkg.version) { replacements.push(job.spec.id); return false; }
      return !cancelled || !!job.hadUpload;
    });
    if (!blocked.length) {
      if (completed.length) {
        const old = completed.find(job => job.observed?.state === "published" || job.observed?.observedPrivacy === "public") || completed[0];
        repeats.push({ packageId: pkg.id, name: pkg.name, version: pkg.version, jobIds: completed.map(job => job.spec.id).sort(), label: old.observed?.state === "published" || old.observed?.observedPrivacy === "public" ? "已发布" : "已完成", videoId: old.observed?.videoId });
      }
      continue;
    }
    const old = blocked.find(job => job.observed?.state === "published") || blocked.find(job => job.spec.desired === "cancel" && job.observed?.revision !== job.spec.revision) || blocked[0];
    const reason = old.observed?.state === "published" ? "published" : old.spec.desired === "cancel" && (old.observed?.revision !== old.spec.revision || old.observed.state !== "cancelled") ? "cancelling" : old.observed?.state === "cancelled" ? "unchanged" : old.observed?.videoId || old.hadUpload ? "uploaded" : "unconfirmed";
    const labels = { published: "已在此频道公开", uploaded: "已有上传记录", cancelling: "取消尚未确认", unchanged: "已取消，素材仍是原版本", unconfirmed: "已有任务待核对" };
    blockers.push({ packageId: pkg.id, name: pkg.name, reason, label: labels[reason], videoId: old.observed?.videoId });
  }
  return { blockers, replacements, repeats };
}
