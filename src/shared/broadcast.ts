/** 开播详情的共享校验；仅包含公开元数据和实例内封面标识。 */
import { z } from "zod";

export const broadcastSchema = z.object({
  title: z.string().trim().min(1, "请填写直播标题").max(100).refine(v => !/[<>]/.test(v), "标题不能包含尖括号"),
  description: z.string().max(5000).refine(v => !/[<>]/.test(v), "说明不能包含尖括号"),
  privacy: z.enum(["public", "unlisted", "private"]),
  madeForKids: z.boolean(),
  playlistIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{10,100}$/)).max(20),
  thumbnail: z.object({ id: z.string().uuid(), name: z.string().min(1).max(180) }).strict().optional(),
}).strict();
export type BroadcastDetails = z.infer<typeof broadcastSchema>;
export const thumbnailInputSchema = z.object({ name: z.string().min(1).max(180), mime: z.enum(["image/jpeg", "image/png"]), data: z.string().min(4).max(2_796_204).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export const playlistResultSchema = z.object({ playlists: z.array(z.object({ id: z.string().max(100), title: z.string().max(200) }).strict()).max(1000) }).strict();
export type Playlist = z.infer<typeof playlistResultSchema>["playlists"][number];

/** 新网页场次明确默认公开；已保存的用户选择优先。 */
export function defaultBroadcast(): BroadcastDetails {
  return { title: "", description: "", privacy: "public", madeForKids: false, playlistIds: [] };
}
