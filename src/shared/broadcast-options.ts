/** 直播规则与账号默认值；配置包只填规则，本场内容始终保留。 */
import { z } from "zod";
import { defaultBroadcast } from "./broadcast";
import type { Selection } from "./types";

export const broadcastDefaultsSchema = z.object({ privacy: z.enum(["public", "unlisted", "private"]), madeForKids: z.boolean(), videoAudio: z.boolean() }).strict();
export type BroadcastDefaults = z.infer<typeof broadcastDefaultsSchema>;
export const initialBroadcastDefaults: BroadcastDefaults = { privacy: "public", madeForKids: false, videoAudio: false };
export const broadcastDefaultsRecordSchema = z.object({ revision: z.number().int().nonnegative(), value: broadcastDefaultsSchema }).strict();

/** 套用配置只改变规则；旧版本包中的文案、封面和素材不会覆盖本场。 */
export function applyBroadcastOptions(current: Selection, preset: Selection): Selection {
  const rules = preset.broadcast || defaultBroadcast();
  return { ...current, videoAudio: preset.videoAudio, broadcast: { ...(current.broadcast || defaultBroadcast()), privacy: rules.privacy, madeForKids: rules.madeForKids, ...(rules.liveChat ? { liveChat: { ...rules.liveChat } } : {}) } };
}

/** 新保存的配置包去除本场内容，保持旧协议可读，不改动既存文件。 */
export function broadcastOptionsSnapshot(value: Selection) {
  return applyBroadcastOptions({ video: "", music: "", videoAudio: false, broadcast: defaultBroadcast() }, value) as Selection & { broadcast: ReturnType<typeof defaultBroadcast> };
}

/** 比较规则而非文案；本场修改标题不会把配置包标成未保存。 */
export function broadcastOptionsSignature(value: Selection) {
  const details = value.broadcast || defaultBroadcast();
  return JSON.stringify([value.videoAudio, details.privacy, details.madeForKids, details.liveChat]);
}
