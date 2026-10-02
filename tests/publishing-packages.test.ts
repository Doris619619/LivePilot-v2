/** 固定 Inbox 的浅层索引回归；使用真实隔离文件，确认大视频扫描不打开内容流。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs", async original => { const actual = await original<typeof import("node:fs")>(); return { ...actual, createReadStream: vi.fn(actual.createReadStream) }; });
import { ensurePublishingRoot, hashPackageFile, publishingRoot, resolvePackageFile, scanPublishingPackages, validatePackage } from "@/core/publishing/packages";

let root: string;
/** 隔离的发布根包含正常批次骨架，不触碰已有 LiveNest 数据。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "publishing-packages-")); await ensurePublishingRoot(root); await mkdir(path.join(root, "Inbox", "Batch")); });
/** 只删除本测试明确创建的临时根，重置环境变量避免污染其他测试。 */
afterEach(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-packages-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
/** 按名称创建浅层包，任意主视频文件名都可识别。 */
async function fixture(name: string, files: Record<string, string | Buffer> = { "video.mp4": "video-bytes" }) {
  const directory = path.join(root, "Inbox", "Batch", name); await mkdir(directory);
  await Promise.all(Object.entries(files).map(([filename, bytes]) => writeFile(path.join(directory, filename), bytes))); return directory;
}

it("indexes one package and 100 naturally ordered packages without reading videos", async () => {
  await fixture("001"); const first = await scanPublishingPackages(root); expect(first.batches[0].packages[0]).toMatchObject({ name: "001", validationState: "valid", sourceVideo: { filename: "video.mp4", sha256: null } });
  await Promise.all(Array.from({ length: 99 }, (_, index) => fixture(String(index + 2).padStart(3, "0"))));
  const result = await scanPublishingPackages(root); expect(result.batches[0].packages).toHaveLength(100);
  expect(result.batches[0].packages.filter(pkg => ["001", "002", "010", "100"].includes(pkg.name)).map(pkg => pkg.name)).toEqual(["001", "002", "010", "100"]); expect(createReadStream).not.toHaveBeenCalled();
}, 15000);

it("keeps missing videos, multiple videos, unsupported formats and extra nesting visible per package", async () => {
  await fixture("001", { "music.mp3": "music" }); await fixture("002", { "video.mp4": "video", "other.mov": "other" }); await fixture("003", { "video.xyz": "unsupported" });
  const fourth = await fixture("004"); await mkdir(path.join(fourth, "nested")); await fixture("005");
  const packages = (await scanPublishingPackages(root)).batches[0].packages;
  expect(packages.map(pkg => pkg.validationState)).toEqual(["invalid", "invalid", "invalid", "invalid", "valid"]);
  expect(packages[0].issues.join()).toContain("缺少主视频"); expect(packages[1].issues.join()).toContain("多个主视频"); expect(packages[2].issues.join()).toContain("不支持"); expect(packages[3].issues.join()).toContain("不能包含子目录");
});

it("allows music, cover and UTF-8 text including an empty description and 100 astral emoji", async () => {
  await fixture("001", { "my-video.mp4": "video", "track.mp3": "music", "cover.png": Buffer.from("89504e470d0a1a0a", "hex"), "title.txt": "😀".repeat(100), "description.txt": "" });
  const pkg = (await scanPublishingPackages(root)).batches[0].packages[0]; expect(pkg).toMatchObject({ validationState: "valid", title: "😀".repeat(100), description: "", sourceMusic: { filename: "track.mp3" }, cover: { filename: "cover.png" } }); expect(createReadStream).not.toHaveBeenCalled();
});

it("reports excess music, duplicate covers, malformed image and UTF-8 metadata boundaries", async () => {
  await fixture("001", { "video.mp4": "video", "a.mp3": "music", "b.wav": "music", "cover.jpg": Buffer.from("ffd8ff", "hex"), "cover.png": Buffer.from("89504e470d0a1a0a", "hex") });
  await fixture("002", { "video.mp4": "video", "cover.png": "not image", "title.txt": "😀".repeat(101), "description.txt": "é".repeat(2501) });
  await fixture("003", { "video.mp4": "video", "title.txt": Buffer.from([0xff]), "description.txt": "é".repeat(2500) });
  const packages = (await scanPublishingPackages(root)).batches[0].packages;
  expect(packages[0].issues.join()).toContain("多首音乐"); expect(packages[0].issues.join()).toContain("多个封面");
  expect(packages[1].issues.join()).toContain("有效的 PNG/JPEG"); expect(packages[1].issues.join()).toContain("100 个 Unicode"); expect(packages[1].issues.join()).toContain("5000 UTF-8"); expect(packages[2].issues.join()).toContain("UTF-8 编码");
});

it("rejects folder junctions, file links and path traversal without hiding good packages", async () => {
  const directory = await fixture("001"); const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "video.mp4"), "outside");
  await symlink(outside, path.join(root, "Inbox", "Batch", "linked"), "junction"); await symlink(outside, path.join(directory, "escape"), "junction");
  const result = await scanPublishingPackages(root); expect(result.batches[0].issues.join()).toContain("普通发布包目录"); expect(result.batches[0].packages[0].issues.join()).toContain("链接");
  await expect(ensurePublishingRoot(path.join(root, "Inbox", "Batch", "linked"))).rejects.toMatchObject({ code: "PACKAGE_PATH" });
  const pkg = result.batches[0].packages[0]; await expect(resolvePackageFile(root, { ...pkg, name: "../outside" }, pkg.sourceVideo!, "video")).rejects.toMatchObject({ code: "PACKAGE_PATH" });
});

it("detects package attachments changing and full Hash changes with restored attributes", async () => {
  const directory = await fixture("001"); const pkg = (await scanPublishingPackages(root)).batches[0].packages[0]; const file = await resolvePackageFile(root, pkg, pkg.sourceVideo!, "video");
  const hash = await hashPackageFile(file); await writeFile(file, "other-bytes"); await utimes(file, new Date(pkg.sourceVideo!.mtimeMs), new Date(pkg.sourceVideo!.mtimeMs));
  await expect(hashPackageFile(file, hash)).rejects.toMatchObject({ code: "ASSET_CHANGED" });
  await writeFile(path.join(directory, "description.txt"), "new description"); await expect(validatePackage(root, pkg)).rejects.toMatchObject({ code: "ASSET_CHANGED" });
});

it("uses explicit root or installed state parent and aborts an active hash", async () => {
  vi.stubEnv("LIVEPILOT_PUBLISHING_ROOT", path.join(root, "custom")); expect(publishingRoot()).toBe(path.join(root, "custom"));
  vi.stubEnv("LIVEPILOT_PUBLISHING_ROOT", ""); vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(root, "state")); expect(publishingRoot()).toBe(path.join(root, "Publishing"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(root, "agent-data")); expect(publishingRoot()).toBe(path.join(root, "agent-data", "Publishing"));
  const directory = await fixture("001"); const controller = new AbortController(); controller.abort(); await expect(hashPackageFile(path.join(directory, "video.mp4"), undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("aborts during a video content stream without leaking or double-closing its file handle", async () => {
  const directory = await fixture("001"); const file = path.join(directory, "video.mp4"); await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 7));
  const handle = await open(file, "r"); const prototype = Object.getPrototypeOf(handle) as { createReadStream: typeof handle.createReadStream }; const original = prototype.createReadStream; await handle.close();
  const controller = new AbortController();
  vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: typeof handle, options) { const stream = original.call(this, options); stream.once("data", () => controller.abort()); return stream; });
  await expect(hashPackageFile(file, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
