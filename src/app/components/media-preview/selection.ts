/** 发布预览沿用已确认账号、发布包版本和封面规则，不创建第二套内容配置。 */
import type { ContentPackage, PublishingProfile } from "@/shared/publishing";
import type { PreviewSelection, PreviewTarget } from "@/shared/media-preview";
/** 准备素材时查看包封面；确认计划后严格跟随正式发布的固定/匹配/无封面策略。 */
export function packagePreviewSelection(target: PreviewTarget, pkg: ContentPackage, profile?: PublishingProfile): PreviewSelection {
  return { agentId: target.agentId, instanceId: target.instanceId, ...(target.accountId ? { accountId: target.accountId } : {}), ...(target.channelId ? { channelId: target.channelId } : {}), source: { kind: "package", packageId: pkg.id, version: pkg.version, ...(profile?.thumbnailMode === "fixed" ? { thumbnail: profile.thumbnailFilename } : {}), ...(profile?.thumbnailMode === "none" ? { noCover: true } : {}) } };
}
