/** 验证详情协议、实例隔离的封面存储和 Agent 心跳往返，使用合成文件。 */
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { broadcastSchema, defaultBroadcast } from "@/shared/broadcast";
import { controlSchema } from "@/shared/remote";
import { dashboardSchema } from "@/shared/remote-validation";
import { Store } from "@/core/storage";
import { readThumbnail, saveThumbnail } from "@/core/broadcast-assets";
const dirs: string[] = [];
/** 只删除本测试创建的临时目录。 */
afterEach(async () => { for (const dir of dirs.splice(0)) { if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("broadcast-test-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true }); } });
it("defaults to public and rejects invalid user metadata at the command boundary", () => {
  const details = { ...defaultBroadcast(), title: "东京雨夜" };
  expect(details.privacy).toBe("public");
  expect(controlSchema.parse({ action: "start", video: "v.mp4", music: "m.mp3", videoAudio: false, broadcast: details })).toMatchObject({ broadcast: details });
  for (const change of [{ title: " " }, { title: "x".repeat(101) }, { description: "<script>" }, { privacy: "secret" }, { playlistIds: ["../../file"] }, { secret: "no" }]) expect(broadcastSchema.safeParse({ ...details, ...change }).success).toBe(false);
});
it("preserves complete details in a sanitized Agent snapshot", () => {
  const broadcast = { ...defaultBroadcast(), title: "准备好的标题", description: "频道说明", madeForKids: true, playlistIds: ["PL_test_playlist"] };
  const result = dashboardSchema.parse({ busy: false, state: { phase: "starting", stage: "设置详情", updatedAt: "now", selection: { video: "v", music: "m", videoAudio: false, broadcast }, detailsApplied: true }, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "public", madeForKids: false }, secret: "stripped" });
  expect(result.state.selection?.broadcast).toEqual(broadcast); expect(result).not.toHaveProperty("secret");
});
it("stores thumbnail bytes only in the owning instance and rejects disguised files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "broadcast-test-")); dirs.push(dir);
  const first = new Store(path.join(dir, "first")); const second = new Store(path.join(dir, "second"));
  const input = { name: "cover.png", mime: "image/png" as const, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64") };
  const ref = await saveThumbnail(first, input);
  expect(ref).not.toHaveProperty("data"); expect(await readThumbnail(first, ref.id)).toEqual(input);
  await expect(readThumbnail(second, ref.id)).rejects.toThrow("不存在");
  await expect(readThumbnail(first, "../secret")).rejects.toThrow("无效");
  await expect(saveThumbnail(first, { ...input, data: Buffer.from("script").toString("base64") })).rejects.toThrow("PNG");
});
