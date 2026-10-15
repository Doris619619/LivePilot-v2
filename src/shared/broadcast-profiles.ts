/** 可复用直播配置的公开协议；只保存内容与素材引用，不包含授权、OBS 连接或运行状态。 */
import { z } from "zod";
import { broadcastSchema } from "./broadcast";
import { idSchema } from "./remote";

const mediaName = z.string().max(255).refine(value => !/[\\/\x00-\x1f]/.test(value) && ![".", ".."].includes(value), "请选择有效的素材文件名");
export const broadcastProfileSelectionSchema = z.object({
  video: mediaName, music: mediaName, videoAudio: z.boolean(),
  broadcast: broadcastSchema.extend({ title: z.union([broadcastSchema.shape.title, z.literal("")]) }),
}).strict();
export type BroadcastProfileSelection = z.infer<typeof broadcastProfileSelectionSchema>;
export const broadcastProfileSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), name: z.string().trim().min(1, "请填写配置名称").max(60, "配置名称最多 60 字"),
  selection: broadcastProfileSelectionSchema, updatedAt: z.number(),
}).strict();
export type BroadcastProfile = z.infer<typeof broadcastProfileSchema>;
export const broadcastProfileTargetSchema = z.object({ agentId: idSchema.optional(), instanceId: idSchema, channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
export type BroadcastProfileTarget = z.infer<typeof broadcastProfileTargetSchema>;
export const broadcastProfileCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), target: broadcastProfileTargetSchema, id: z.string().uuid(), revision: z.number().int().nonnegative(), name: broadcastProfileSchema.shape.name, selection: broadcastProfileSelectionSchema }).strict(),
  z.object({ action: z.literal("delete"), target: broadcastProfileTargetSchema, id: z.string().uuid(), revision: z.number().int().positive() }).strict(),
]);
export type BroadcastProfileCommand = z.infer<typeof broadcastProfileCommandSchema>;

/** 固定字段顺序比较草稿与配置；播放列表顺序不影响是否已修改。 */
export function broadcastProfileSignature(value: BroadcastProfileSelection) {
  const { broadcast } = value;
  return JSON.stringify([value.video, value.music, value.videoAudio, broadcast.title, broadcast.description, broadcast.privacy, broadcast.madeForKids, [...broadcast.playlistIds].sort(), broadcast.thumbnail?.id || "", broadcast.thumbnail?.name || ""]);
}
