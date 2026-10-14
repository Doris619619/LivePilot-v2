/** ffprobe 元信息兼容测试：流时长未知时仍使用容器时长，不将正常素材误报为无法检查。 */
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ duration: "N/A" }));
vi.mock("node:child_process", () => ({
  /** 模拟 ffprobe 成功输出，覆盖未知/无效流时长而不是依赖本机安装。 */
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, duration: fixture.duration }, { codec_type: "audio" }], format: { duration: "12.5" } })));
      child.emit("close", 0);
    });
    return child;
  },
}));
import { inspectMetadata } from "@/core/preview/inspect";
import type { PreviewFile } from "@/shared/media-preview";

it.each(["N/A", "0", "-1", "Infinity", ""])('falls back to container duration when the video duration is "%s"', async duration => {
  fixture.duration = duration;
  const info: PreviewFile = { name: "video.mp4", size: 1, version: "fixture", mime: "video/mp4" };
  await inspectMetadata("fixture.mp4", info, { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }, new AbortController().signal);
  expect(info).toMatchObject({ duration: 12.5, video: true, audio: true, width: 960, height: 540 });
});
