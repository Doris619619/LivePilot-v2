/** 从既有 YouTube 频道回复提取头像；不添加授权权限，也不保存原始回复。 */
import { channelAvatarUrlSchema } from "@/shared/publishing-account-identity";

export type ChannelSnippet = { title: string; thumbnails?: { default?: { url?: string }; medium?: { url?: string }; high?: { url?: string } } };

/** 优先使用适合头像的缩略图；缺图或非 Google HTTPS 地址时保持缺失，由界面显示占位。 */
export function channelAvatar(snippet: ChannelSnippet) {
  for (const thumbnail of [snippet.thumbnails?.medium, snippet.thumbnails?.default, snippet.thumbnails?.high]) {
    const value = channelAvatarUrlSchema.safeParse(thumbnail?.url);
    if (value.success) return value.data;
  }
}

