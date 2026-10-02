/** FFmpeg wrapper 回归使用模拟子进程和真实文件，覆盖输出缓存、短长音乐、停止与崩溃恢复。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { PublishingStore } from "@/core/publishing/storage";
import { ensurePublishingRoot, scanPublishingPackages } from "@/core/publishing/packages";
import { preparePackageUpload, validatePreparedUpload } from "@/core/publishing/render";

const execution = vi.hoisted(() => ({ calls: [] as { executable: string; args: string[] }[], failures: 0, invalidOutput: false, hold: false, musicDuration: 3, onRenderSpawn: undefined as ((child: ChildProcess) => void) | undefined }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events"); const { PassThrough } = await import("node:stream"); const fs = await import("node:fs/promises");
  return { spawn: vi.fn((executable: string, args: string[]) => {
    const child = new EventEmitter() as import("node:child_process").ChildProcess; const stdout = new PassThrough(); const stderr = new PassThrough();
    Object.assign(child, { pid: process.pid, stdout, stderr, kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; }) }); execution.calls.push({ executable, args });
    if (path.basename(executable).startsWith("ffmpeg")) execution.onRenderSpawn?.(child);
    queueMicrotask(async () => {
      try {
        if (path.basename(executable).startsWith("ffprobe")) {
          const filename = args.at(-1)!; const audio = /\.mp3$/i.test(filename); const output = /(?:output\.|output\.mp4)/i.test(path.basename(filename));
          stdout.end(JSON.stringify({ streams: audio ? [{ index: 0, codec_type: "audio", duration: String(execution.musicDuration) }] : [{ index: 0, codec_type: "video", codec_name: "h264", duration: output && execution.invalidOutput ? "9" : "10" }, ...(output ? [{ index: 1, codec_type: "audio", duration: "10" }] : [])], format: { duration: audio ? String(execution.musicDuration) : "10" } }));
        } else {
          if (execution.hold) return;
          if (execution.failures > 0) { execution.failures--; stderr.end("Unsupported codec"); child.emit("close", 1); return; }
          await fs.writeFile(args.at(-1)!, "final-video-bytes"); await fs.utimes(args.at(-1)!, new Date(1700000000000), new Date(1700000000000));
        }
        child.emit("close", 0);
      } catch (error) { child.emit("error", error); child.emit("close", 1); }
    }); return child;
  }) };
});

let base: string; let root: string;
/** 模拟工具必须是实际存在的普通文件；PATH 置空，测试不依赖开发者系统安装。 */
beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "publishing-render-")); root = path.join(base, "Publishing"); await ensurePublishingRoot(root); await mkdir(path.join(base, "tools"));
  await writeFile(path.join(base, "tools", "ffmpeg.exe"), "mock-tool"); await writeFile(path.join(base, "tools", "ffprobe.exe"), "mock-tool");
  await mkdir(path.join(root, "Inbox", "Batch", "001"), { recursive: true }); await writeFile(path.join(root, "Inbox", "Batch", "001", "video.mp4"), "video-bytes");
  await utimes(path.join(root, "Inbox", "Batch", "001", "video.mp4"), new Date(1700000000000), new Date(1700000000000));
  vi.stubEnv("PATH", ""); execution.calls.length = 0; execution.failures = 0; execution.invalidOutput = false; execution.hold = false; execution.musicDuration = 3; execution.onRenderSpawn = undefined;
});
/** 仅清理明确属于本测试的根，模拟子进程不会触碰真实 FFmpeg 或用户媒体。 */
afterEach(async () => { if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith("publishing-render-")) throw new Error("Unsafe cleanup"); await rm(base, { recursive: true, force: true }); vi.unstubAllEnvs(); });
/** 按当前真实属性读取唯一包，音乐在需要时作为可选源加入。 */
async function fixture(withMusic = true) {
  if (withMusic) { await writeFile(path.join(root, "Inbox", "Batch", "001", "music.mp3"), "music-bytes"); await utimes(path.join(root, "Inbox", "Batch", "001", "music.mp3"), new Date(1700000000000), new Date(1700000000000)); }
  return (await scanPublishingPackages(root)).batches[0].packages[0];
}
/** 统计真正生成视频的命令，不把轻量 ffprobe 当作重新渲染。 */
function renders() { return execution.calls.filter(call => path.basename(call.executable).startsWith("ffmpeg")); }

it("uploads the original video without invoking FFmpeg when music is absent", async () => {
  const pkg = await fixture(false); await rm(path.join(base, "tools"), { recursive: true });
  const prepared = await preparePackageUpload(root, pkg); expect(prepared.relativePath).toBe("Inbox/Batch/001/video.mp4"); expect(prepared.asset.filename).toBe("video.mp4"); expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/); expect(execution.calls).toHaveLength(0);
  const checked = await validatePreparedUpload(root, prepared, pkg); expect(checked.file).toBe(await realpath(path.join(root, "Inbox", "Batch", "001", "video.mp4")));
});

it.each([3, 30])("loops music of length %s and truncates at the video duration while preserving picture", async duration => {
  const pkg = await fixture(); execution.musicDuration = duration; const prepared = await preparePackageUpload(root, pkg);
  expect(prepared.relativePath).toBe("Working/Batch/001/" + pkg.version + "/output.mp4"); expect(renders()).toHaveLength(1);
  expect(renders()[0].args).toEqual(expect.arrayContaining(["-stream_loop", "-1", "-t", "10", "-c:v", "copy", "-c:a", "aac", "-map", "0:0", "1:0"]));
  expect(await readFile(path.join(root, ...prepared.relativePath.split("/")), "utf8")).toBe("final-video-bytes");
  expect(await readFile(path.join(root, "Inbox", "Batch", "001", "video.mp4"), "utf8")).toBe("video-bytes");
});

it("reuses a validated cached output after restart without requiring tools again", async () => {
  const pkg = await fixture(); const first = await preparePackageUpload(root, pkg); const calls = execution.calls.length; await rm(path.join(base, "tools"), { recursive: true });
  const second = await preparePackageUpload(root, pkg); expect(second).toEqual(first); expect(execution.calls).toHaveLength(calls); await expect(validatePreparedUpload(root, first, pkg)).resolves.toMatchObject({ sha256: first.sha256 });
});

it("fails clearly if tools are missing only for a package needing music", async () => {
  const pkg = await fixture(); await rm(path.join(base, "tools"), { recursive: true }); await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "FFMPEG_MISSING" }); expect(renders()).toHaveLength(0);
});

it("falls back to two-thread H.264 encoding and defers that work during an explicit live session", async () => {
  const pkg = await fixture(); execution.failures = 1; await expect(preparePackageUpload(root, pkg, { live: () => true })).rejects.toMatchObject({ code: "RENDER_WAIT" }); expect(renders()).toHaveLength(1);
  execution.failures = 1; await preparePackageUpload(root, pkg, { live: () => false }); expect(renders().at(-1)!.args).toEqual(expect.arrayContaining(["libx264", "-threads:v", "2", "aac"]));
});

it("records render failure and rejects a failed length validation before upload", async () => {
  const pkg = await fixture(); execution.failures = 2; await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "FFMPEG_FAILED" });
  const record = JSON.parse(await readFile(path.join(root, "Working", "Batch", "001", pkg.version, "render.json"), "utf8")); expect(record.state).toBe("failed"); expect(record.message).toContain("FFmpeg 生成失败");
  execution.invalidOutput = true; await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "RENDER_OUTPUT" });
});

it("uses a new output version after source changes and refuses changed fixed output or forged relative paths", async () => {
  const pkg = await fixture(); const first = await preparePackageUpload(root, pkg);
  const output = path.join(root, ...first.relativePath.split("/")); await writeFile(output, "other-video-bytes"); await utimes(output, new Date(first.asset.mtimeMs), new Date(first.asset.mtimeMs));
  await expect(validatePreparedUpload(root, first, pkg)).rejects.toMatchObject({ code: "ASSET_CHANGED" });
  await expect(validatePreparedUpload(root, { ...first, relativePath: "../outside.mp4" }, pkg)).rejects.toMatchObject({ code: "RENDER_CACHE" });
  await writeFile(path.join(root, "Inbox", "Batch", "001", "music.mp3"), "a-new-track"); const changed = (await scanPublishingPackages(root)).batches[0].packages[0]; const second = await preparePackageUpload(root, changed);
  expect(second.relativePath).not.toBe(first.relativePath); expect(renders()).toHaveLength(2); await expect(validatePreparedUpload(root, first, pkg)).rejects.toMatchObject({ code: "ASSET_CHANGED" });
});

it("recovers an atomically renamed output whose ready journal write was lost without rendering twice", async () => {
  const pkg = await fixture(); const original = PublishingStore.prototype.write; let loseReady = true;
  vi.spyOn(PublishingStore.prototype, "write").mockImplementation(async function (this: PublishingStore, name, value) {
    if (name === "render.json" && (value as { state?: string }).state === "ready" && loseReady) { loseReady = false; throw new Error("simulated crash after rename"); }
    return original.call(this, name, value);
  });
  await expect(preparePackageUpload(root, pkg)).rejects.toThrow("simulated crash after rename"); expect(renders()).toHaveLength(1);
  await expect(preparePackageUpload(root, pkg)).resolves.toMatchObject({ asset: { filename: "output.mp4" } }); expect(renders()).toHaveLength(1);
});

it("never adopts an existing output without a durable render intention", async () => {
  const pkg = await fixture(); const folder = path.join(root, "Working", "Batch", "001", pkg.version); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, "output.mp4"), "unverified");
  await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "RENDER_CACHE" }); await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "RENDER_CACHE" }); expect(renders()).toHaveLength(0); expect(await readFile(path.join(folder, "output.mp4"), "utf8")).toBe("unverified");
});

it.each(["video.mp4", "music.mp3"])("detects changed %s bytes with restored size and mtime before reusing cache", async filename => {
  const pkg = await fixture(); const prepared = await preparePackageUpload(root, pkg); const file = path.join(root, "Inbox", "Batch", "001", filename);
  await writeFile(file, "other-bytes"); await utimes(file, new Date(1700000000000), new Date(1700000000000));
  expect((await scanPublishingPackages(root)).batches[0].packages[0].version).toBe(pkg.version);
  await expect(validatePreparedUpload(root, prepared, pkg)).rejects.toMatchObject({ code: "ASSET_CHANGED" }); await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "ASSET_CHANGED" }); expect(renders()).toHaveLength(1);
});

it("stops its own process on abort and prevents a second generation on the same device", async () => {
  const pkg = await fixture(); execution.hold = true; const controller = new AbortController();
  /** 真正创建本测试的 FFmpeg 子进程时才继续，避免把磁盘准备耗时误判为未生成。 */
  const spawned = new Promise<ChildProcess>(resolve => { execution.onRenderSpawn = resolve; });
  const active = preparePackageUpload(root, pkg, { signal: controller.signal });
  /** 立即处理失败，前置断言失败时也必须中止并排空活动任务，再允许 afterEach 删除目录。 */
  const outcome = active.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const child = await Promise.race([spawned, outcome.then(result => { if (!result.ok) throw result.error; throw new Error("The upload preparation completed without starting the expected FFmpeg process"); })]);
    expect(renders()).toHaveLength(1); await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "RENDER_WAIT" });
    controller.abort(); expect(await outcome).toMatchObject({ ok: false, error: { name: "AbortError" } }); expect(child.kill).toHaveBeenCalledOnce();
  } finally { controller.abort(); await outcome; execution.hold = false; execution.onRenderSpawn = undefined; }
  await expect(preparePackageUpload(root, pkg)).resolves.toMatchObject({ asset: { filename: "output.mp4" } });
});

it("preserves an unknown generation lock instead of silently deleting it", async () => {
  const pkg = await fixture(); const lock = path.join(root, "Working", ".render.lock"); await writeFile(lock, JSON.stringify({ owner: 0 }));
  await expect(preparePackageUpload(root, pkg)).rejects.toMatchObject({ code: "RENDER_WAIT" }); expect(await readFile(lock, "utf8")).toBe(JSON.stringify({ owner: 0 })); expect(renders()).toHaveLength(0);
});
