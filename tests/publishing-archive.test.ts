/** 整批手工归档使用真实目录 rename 与持久日志，覆盖中断、重复请求和不覆盖源文件。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensurePublishingRoot, scanPublishingPackages } from "@/core/publishing/packages";
import { archivePublishingBatch } from "@/core/publishing/archive";
import { PublishingStore } from "@/core/publishing/storage";

let root: string;
/** 单一合法发布包代表 Cloud 已核对全部终态的批次，目录放在独立测试根。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "publishing-archive-")); await ensurePublishingRoot(root); await mkdir(path.join(root, "Inbox", "Batch", "001"), { recursive: true }); await writeFile(path.join(root, "Inbox", "Batch", "001", "video.mp4"), "source-video"); });
/** 明确验证临时目录范围后清理，不操作任何本机真实内容。 */
afterEach(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-archive-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });

it("moves the batch only on explicit archive and preserves source bytes and Working caches", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; await writeFile(path.join(root, "Working", "keep.txt"), "cache");
  const first = await archivePublishingBatch(root, batch, "archive-01"); expect(first).toEqual({ state: "complete", destination: path.join(root, "Completed", "Batch--archive-01") });
  expect(await readdir(path.join(root, "Inbox"))).toEqual([]); expect(await readFile(path.join(first.destination, "001", "video.mp4"), "utf8")).toBe("source-video"); expect(await readFile(path.join(root, "Working", "keep.txt"), "utf8")).toBe("cache");
  expect(await archivePublishingBatch(root, batch, "archive-01")).toEqual(first);
});

it("recovers after moving a batch but losing its completed journal write", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; const original = PublishingStore.prototype.write; let loseComplete = true;
  vi.spyOn(PublishingStore.prototype, "write").mockImplementation(async function (this: PublishingStore, name, value) { if (name === "archive-02.json" && (value as { state?: string }).state === "complete" && loseComplete) { loseComplete = false; throw new Error("simulated crash after move"); } return original.call(this, name, value); });
  await expect(archivePublishingBatch(root, batch, "archive-02")).rejects.toMatchObject({ code: "ARCHIVE_UNCERTAIN" }); expect(await readdir(path.join(root, "Inbox"))).toEqual([]);
  await expect(archivePublishingBatch(root, batch, "archive-02")).resolves.toMatchObject({ state: "complete" });
  const saved = JSON.parse(await readFile(path.join(root, "Completed", ".archives", "archive-02.json"), "utf8")); expect(saved.state).toBe("complete");
});

it("detects changed or invalid source batches without moving them", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; await writeFile(path.join(root, "Inbox", "Batch", "001", "description.txt"), "new description");
  await expect(archivePublishingBatch(root, batch, "archive-03")).rejects.toMatchObject({ code: "ARCHIVE_SOURCE_CHANGED" }); expect(await readdir(path.join(root, "Inbox"))).toEqual(["Batch"]);
  await expect(archivePublishingBatch(root, { ...batch, issues: ["bad package"] }, "archive-03")).rejects.toMatchObject({ code: "ARCHIVE_BATCH" });
});

it("rejects reused identities, destination collisions and links without overwriting user files", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; await mkdir(path.join(root, "Completed", "Batch--archive-04")); await writeFile(path.join(root, "Completed", "Batch--archive-04", "keep.txt"), "untouched");
  await expect(archivePublishingBatch(root, batch, "archive-04")).rejects.toMatchObject({ code: "ARCHIVE_CONFLICT" }); expect(await readFile(path.join(root, "Completed", "Batch--archive-04", "keep.txt"), "utf8")).toBe("untouched");
  await expect(archivePublishingBatch(root, batch, "../escape")).rejects.toMatchObject({ code: "PACKAGE_PATH" });
  await symlink(path.join(root, "Inbox", "Batch"), path.join(root, "Completed", "Batch--archive-05"), "junction"); await expect(archivePublishingBatch(root, batch, "archive-05")).rejects.toMatchObject({ code: "ARCHIVE_CONFLICT" });
  await archivePublishingBatch(root, batch, "archive-06"); await expect(archivePublishingBatch(root, { ...batch, version: "0".repeat(64) }, "archive-06")).rejects.toMatchObject({ code: "ARCHIVE_ID" });
});

it("keeps malformed or unreadable journal results uncertain without moving source data", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; const folder = path.join(root, "Completed", ".archives"); await mkdir(folder); await writeFile(path.join(folder, "archive-07.json"), "invalid JSON");
  await expect(archivePublishingBatch(root, batch, "archive-07")).rejects.toMatchObject({ code: "ARCHIVE_UNCERTAIN" }); expect(await readdir(path.join(root, "Inbox"))).toEqual(["Batch"]); expect(await readFile(path.join(folder, "archive-07.json"), "utf8")).toBe("invalid JSON");
});

it("treats a change discovered after rename as uncertain and preserves the prepared journal", async () => {
  const batch = (await scanPublishingPackages(root)).batches[0]; const original = PublishingStore.prototype.write;
  vi.spyOn(PublishingStore.prototype, "write").mockImplementation(async function (this: PublishingStore, name, value) {
    await original.call(this, name, value);
    if (name === "archive-08.json" && (value as { state?: string }).state === "prepared") await writeFile(path.join(root, "Inbox", "Batch", "001", "description.txt"), "changed during archive");
  });
  await expect(archivePublishingBatch(root, batch, "archive-08")).rejects.toMatchObject({ code: "ARCHIVE_UNCERTAIN" }); expect(await readdir(path.join(root, "Inbox"))).toEqual([]);
  expect(await readFile(path.join(root, "Completed", "Batch--archive-08", "001", "description.txt"), "utf8")).toBe("changed during archive");
  const saved = JSON.parse(await readFile(path.join(root, "Completed", ".archives", "archive-08.json"), "utf8")); expect(saved.state).toBe("prepared");
});
