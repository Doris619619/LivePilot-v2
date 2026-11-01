/** 发布账号频道头像的边界验证；所有图片地址和频道均为合成值。 */
import { expect, it } from "vitest";
import { channelAvatarUrlSchema, publishingAccountIdentitySchema } from "@/shared/publishing-account-identity";
import { publishingAccountReportSchema, publishingAccountSchema } from "@/shared/publishing";
import { channelAvatar } from "@/core/youtube/account-identity";

it("allows optional public identity without admitting secrets or arbitrary image destinations", () => {
  const metadata = { channelAvatarUrl: "https://yt3.ggpht.com/synthetic=s88-c-k" };
  expect(publishingAccountIdentitySchema.parse(metadata)).toEqual(metadata);
  for (const url of ["not a URL", "javascript:alert(1)", "data:image/png;base64,AAAA", "http://yt3.ggpht.com/avatar", "https://yt3.ggpht.com.attacker.invalid/avatar", "https://alice:secret@yt3.ggpht.com/avatar", "https://yt3.ggpht.com:444/avatar"]) expect(channelAvatarUrlSchema.safeParse(url).success).toBe(false);
  const account = { id: "a1111111-1111-4111-8111-111111111111", agentId: "pc", instanceId: "main", name: "Synthetic", owner: "alice", status: "connected", createdAt: 1, updatedAt: 1, ...metadata };
  expect(publishingAccountSchema.parse(account)).toMatchObject(metadata);
  expect(publishingAccountSchema.safeParse({ ...account, accessToken: "private" }).success).toBe(false);
  expect(publishingAccountReportSchema.parse({ id: account.id, instanceId: "main", identity: metadata })).toMatchObject({ identity: metadata });
  expect(publishingAccountReportSchema.safeParse({ id: account.id, instanceId: "main", identity: { ...metadata, sub: "private" } }).success).toBe(false);
  expect(channelAvatar({ title: "Synthetic", thumbnails: { medium: { url: "https://attacker.invalid/a" }, default: { url: metadata.channelAvatarUrl } } })).toBe(metadata.channelAvatarUrl);
});

it("keeps missing and rejected image metadata absent for the UI fallback", () => {
  expect(publishingAccountIdentitySchema.parse({})).toEqual({});
  expect(channelAvatar({ title: "Synthetic" })).toBeUndefined();
  expect(channelAvatar({ title: "Synthetic", thumbnails: { default: { url: "https://attacker.invalid/image" } } })).toBeUndefined();
});
