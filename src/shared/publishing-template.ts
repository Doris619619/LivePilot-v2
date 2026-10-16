/** 账号通用视频配置包；设备、频道和素材只在使用时绑定，执行协议仍要求完整目标。 */
import { z } from "zod";
import { profileSchema, type PublishingProfile } from "./publishing";

export const publishingTemplateSchema = z.object({
  ...profileSchema.shape, name: z.string().trim().min(1, "请填写配置名称").max(80),
}).omit({ agentId: true, instanceId: true, accountId: true, channelId: true, playlistIds: true, thumbnailFilename: true }).strict()
  .refine(value => !value.scheduled || value.privacy === "public", "只有公开模式可定时发布");
export type PublishingTemplate = z.infer<typeof publishingTemplateSchema>;
export const publishingUseSchema = z.object({
  agentId: profileSchema.shape.agentId, instanceId: profileSchema.shape.instanceId,
  accountId: z.string().uuid(), channelId: profileSchema.shape.channelId,
  playlistIds: profileSchema.shape.playlistIds, thumbnailFilename: profileSchema.shape.thumbnailFilename,
  templateRevision: z.number().int().positive(),
}).strict();
export type PublishingUse = z.infer<typeof publishingUseSchema>;

/** 迁移只提取通用字段；源配置和历史任务原样保留。 */
export function publishingTemplate(profile: PublishingProfile): PublishingTemplate {
  return publishingTemplateSchema.parse(Object.fromEntries(Object.entries(profile).filter(([key]) => !["agentId", "instanceId", "accountId", "channelId", "playlistIds", "thumbnailFilename"].includes(key))));
}

/** 只在已选择发布目标后构建执行快照；固定图片必须在当前设备重新选择。 */
export function bindPublishingTemplate(template: PublishingTemplate, use: PublishingUse): PublishingProfile {
  const { templateRevision, ...target } = publishingUseSchema.parse(use);
  if (templateRevision !== template.revision) throw new Error("配置包已更新，请重新读取配置并生成排期。");
  return profileSchema.parse({ ...template, ...target, scheduled: template.privacy === "public" });
}
