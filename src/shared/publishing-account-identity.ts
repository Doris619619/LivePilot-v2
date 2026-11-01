/** 发布账号可展示的频道头像；不包含授权邮箱、主体 ID、Token 或任意外站图片。 */
import { z } from "zod";

/** 只接受 Google 图片域名的 HTTPS 地址，禁止凭据、端口及可执行协议进入浏览器图片请求。 */
export const channelAvatarUrlSchema = z.string().max(2048).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && ["googleusercontent.com", "ggpht.com"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
  } catch { return false; }
}, "频道头像地址无效");

export const publishingAccountIdentitySchema = z.object({ channelAvatarUrl: channelAvatarUrlSchema.optional() }).strict();
export type PublishingAccountIdentity = z.infer<typeof publishingAccountIdentitySchema>;
