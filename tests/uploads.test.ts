/** 临时媒体库验证真实分片落盘、续传校验和无覆盖发布。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CHUNK_SIZE, createUpload, uploadChunk, uploadStatus, prepareFinish, finishUpload, cancelUpload } from "@/server/uploads";
import { scanMedia } from "@/server/media";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
let dir: string;
/** 哈希与浏览器按分片清单生成的文件身份一致。 */
function sha(data: Buffer | string) { return createHash("sha256").update(data).digest("hex"); }
/** 构造真实二进制请求，不使用真实网络。 */
function request(data: Buffer) { return new Request("http://localhost/upload", { method: "PUT", body: new Uint8Array(data) }); }
/** 所有素材及认证数据均位于隔离临时目录。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-upload-"));
  await mkdir(path.join(dir, "videos")); await mkdir(path.join(dir, "music"));
  vi.stubEnv("LIVEPILOT_MEDIA_ROOT", dir); vi.stubEnv("LIVEPILOT_ACCESS_DIR", path.join(dir, "access")); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010");
});
/** 清理仅限测试生成的临时素材库。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("livepilot-upload-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
it("resumes only acknowledged bytes and publishes after full verification without overwrite", async () => {
  const one = Buffer.alloc(CHUNK_SIZE, 7); const two = Buffer.from("end");
  const fingerprint = sha(sha(one) + sha(two));
  await writeFile(path.join(dir, "videos", "中文.mp4"), "existing");
  const upload = await createUpload("main", "alice", { kind: "videos", filename: "中文.mp4", size: one.length + two.length, fingerprint });
  expect((await scanMedia(dir)).videos).toEqual(["中文.mp4"]);
  await uploadChunk("main", "alice", upload.id, 0, sha(one), request(one));
  expect((await uploadStatus("main", "alice", upload.id)).received).toBe(CHUNK_SIZE);
  await uploadChunk("main", "alice", upload.id, 0, sha(one), request(one));
  expect((await uploadStatus("main", "alice", upload.id)).received).toBe(CHUNK_SIZE);
  await expect(prepareFinish("main", "alice", upload.id)).rejects.toMatchObject({ status: 409 });
  await uploadChunk("main", "alice", upload.id, CHUNK_SIZE, sha(two), request(two));
  await prepareFinish("main", "alice", upload.id);
  const result = await finishUpload("main", "alice", upload.id);
  expect(result.status).toBe("complete");
  expect(sha(await readFile(path.join(dir, "videos", result.publishedName!)))).toBe(sha(Buffer.concat([one, two])));
  expect(await readFile(path.join(dir, "videos", "中文.mp4"), "utf8")).toBe("existing");
  expect((await finishUpload("main", "alice", upload.id)).publishedName).toBe(result.publishedName);
  await cancelUpload("main", "alice", upload.id);
  expect(sha(await readFile(path.join(dir, "videos", result.publishedName!)))).toBe(sha(Buffer.concat([one, two])));
});
it("rejects corrupted, interrupted and oversized chunks without advancing offset", async () => {
  const data = Buffer.from("good");
  const upload = await createUpload("main", "alice", { kind: "music", filename: "test.mp3", size: data.length, fingerprint: sha(sha(data)) });
  for (const bad of [Buffer.from("baad"), Buffer.from("g"), Buffer.from("too long")]) await expect(uploadChunk("main", "alice", upload.id, 0, sha(data), request(bad))).rejects.toBeDefined();
  expect((await uploadStatus("main", "alice", upload.id)).received).toBe(0);
  expect((await readFile(path.join(dir, ".uploads", upload.id, "content.part"))).length).toBe(0);
  await expect(uploadStatus("main", "bob", upload.id)).rejects.toMatchObject({ status: 404 });
});
it("rejects a different complete file fingerprint and never lists partial media", async () => {
  const data = Buffer.from("file");
  const upload = await createUpload("main", "alice", { kind: "videos", filename: "test.mp4", size: data.length, fingerprint: "a".repeat(64) });
  await uploadChunk("main", "alice", upload.id, 0, sha(data), request(data)); await prepareFinish("main", "alice", upload.id);
  await expect(finishUpload("main", "alice", upload.id)).rejects.toMatchObject({ code: "HASH" });
  expect((await scanMedia(dir)).videos).toEqual([]);
});
it("rejects unsupported names, oversized files and junction escape", async () => {
  const input = { kind: "videos" as const, filename: "../escape.mp4", size: 4, fingerprint: "a".repeat(64) };
  await expect(createUpload("main", "alice", input)).rejects.toMatchObject({ code: "MEDIA" });
  vi.stubEnv("LIVEPILOT_UPLOAD_MAX_BYTES", "3");
  await expect(createUpload("main", "alice", { ...input, filename: "ok.mp4" })).rejects.toMatchObject({ status: 413 });
  vi.stubEnv("LIVEPILOT_UPLOAD_MAX_BYTES", "100");
  await symlink(path.join(dir, "music"), path.join(dir, ".uploads"), "junction");
  await expect(createUpload("main", "alice", { ...input, filename: "ok.mp4" })).rejects.toMatchObject({ code: "MEDIA" });
});

it("reserves remaining disk space across uploads and expires only temporary data", async () => {
  const input = { kind: "videos" as const, filename: "test.mp4", size: 200, fingerprint: "a".repeat(64) };
  const actual = await fs.statfs(dir);
  vi.mocked(fs.statfs).mockResolvedValue({ ...actual, bavail: 512 * 1024 * 1024 + 300, bsize: 1 });
  const first = await createUpload("main", "alice", input);
  await expect(createUpload("main", "bob", input)).rejects.toMatchObject({ status: 507 });
  const metadata = path.join(dir, ".uploads", first.id, "upload.json");
  const record = JSON.parse(await readFile(metadata, "utf8")); record.expiresAt = 1;
  await writeFile(metadata, JSON.stringify(record));
  await createUpload("main", "alice", input);
  await expect(readFile(metadata)).rejects.toMatchObject({ code: "ENOENT" });
});
