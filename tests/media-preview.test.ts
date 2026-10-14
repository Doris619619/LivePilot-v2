/** 预览协议与 Agent 真实文件边界测试，隔离目录，不访问真实账号、OBS 或 YouTube。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { previewRange, previewSourceSchema, PREVIEW_CHUNK, type PreviewCommand } from "@/shared/media-preview";
import { sampleRanges } from "@/core/preview/inspect";
import { AgentPreviewSessions } from "@/core/preview/session";
import { PublishingRunner } from "@/core/publishing/runner";
import { requestPreview, pollPreview, acceptPreview } from "@/cloud/preview-relay";
import { scanPublishingPackages } from "@/core/publishing/packages";
let root: string; let sessions: AgentPreviewSessions; let runner: PublishingRunner;
const target = { agentId: "test_device", instanceId: "main" };
/** 隔离 Agent 数据目录，刻意禁用 FFmpeg 验证工具缺失与文件损坏不会混淆。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "media-preview-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", root); vi.stubEnv("LIVEPILOT_PUBLISHING_ROOT", path.join(root, "Publishing")); vi.stubEnv("PATH", "");
  await mkdir(path.join(root, "videos")); await writeFile(path.join(root, "videos", "sample.mp4"), "real-local-bytes");
  runner = new PublishingRunner(new Map()); sessions = new AgentPreviewSessions(runner, async value => { if (value.agentId !== target.agentId || value.instanceId !== target.instanceId) throw new Error("TARGET"); });
});
/** 只删除当前测试创建的已解析目录；停止全部检查后再清理。 */
afterEach(async () => { await sessions.stop(); await runner.stop(); vi.unstubAllEnvs(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("media-preview-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 生成短期会话指令，所有素材均由 Agent 按标识解析。 */
function command(action: PreviewCommand["action"], session: string = randomUUID()): PreviewCommand { return { id: randomUUID(), session, target, expires: Date.now() + 60_000, action }; }

it("accepts precise normal/open/suffix ranges and rejects multi-range or invalid offsets", () => {
  expect(previewRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5, partial: true }); expect(previewRange("bytes=7-", 10).end).toBe(9); expect(previewRange("bytes=-3", 10).start).toBe(7);
  for (const value of ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-"]) expect(() => previewRange(value, 10)).toThrow();
  expect(previewSourceSchema.safeParse({ kind: "live", video: "../secret.mp4" }).success).toBe(false);
  expect(sampleRanges(2)).toEqual([{ start: 0, duration: 2 }]); expect(sampleRanges(90).map(r => r.start)).toEqual([0, 43.5, 87]);
});
it("reads actual bytes, reports unavailable tools, and invalidates replaced or closed files", async () => {
  const first = command("open"); const state = await sessions.execute({ ...first, source: { kind: "live", video: "sample.mp4" } }); expect(JSON.stringify(state)).not.toContain(root);
  await vi.waitFor(async () => expect(await sessions.execute({ ...first, action: "status" })).toMatchObject({ busy: false, files: { video: { check: { state: "unavailable" } } } }));
  const bytes = await sessions.execute({ ...first, action: "bytes", part: "video", offset: 2, count: 4 }); expect(Buffer.from(bytes as Uint8Array).toString()).toBe("al-l");
  await writeFile(path.join(root, "videos", "sample.mp4"), "replaced-media-file");
  await expect(sessions.execute({ ...first, action: "status" })).rejects.toMatchObject({ code: "ASSET_CHANGED" });
  await expect(sessions.execute({ ...first, action: "bytes", part: "video", offset: 0, count: 1 })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  const next = command("open"); await sessions.execute({ ...next, source: { kind: "live", video: "sample.mp4" } }); await sessions.execute({ ...next, action: "close" }); await expect(sessions.execute({ ...next, action: "status" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
});
it("rejects changed account targets and expires sessions", async () => {
  const first = command("open"); await sessions.execute({ ...first, source: { kind: "live", video: "sample.mp4" } });
  await expect(sessions.execute({ ...first, target: { ...target, accountId: randomUUID() }, action: "status" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  const expired = command("open"); await sessions.execute({ ...expired, expires: Date.now() - 1, source: { kind: "live", video: "sample.mp4" } });
  await expect(sessions.execute({ ...expired, action: "status" })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
});
it("does not start work when shutdown overtakes an in-flight authorization", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const late = new AgentPreviewSessions(runner, () => waiting);
  const work = vi.spyOn(runner, "previewWork");
  const pending = late.execute({ ...command("open"), source: { kind: "live", video: "sample.mp4" } });
  const rejected = expect(pending).rejects.toMatchObject({ code: "PREVIEW_STOPPED" });
  await late.stop(); release(); await rejected;
  expect(work).not.toHaveBeenCalled();
  await expect(late.execute(command("status"))).rejects.toMatchObject({ code: "PREVIEW_STOPPED" });
});
it("package preparation stays inside PublishingRunner and reuses the exact original file without upload", async () => {
  const folder = path.join(root, "Publishing", "Inbox", "batch", "item"); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, "video.mp4"), "original-upload-bytes");
  const pkg = (await scanPublishingPackages(path.join(root, "Publishing"))).batches[0].packages[0];
  const result = await runner.previewWork(new AbortController().signal, signal => runner.preparePreview(pkg, signal));
  expect(await readFile(result.file, "utf8")).toBe("original-upload-bytes"); expect(result.upload.sha256).toBe(result.sha256); expect(await runner.reports()).toEqual([]);
});
it("prioritizes broadcasts and prevents parallel preview work", async () => {
  const live = new PublishingRunner(new Map(), { live: () => true }); await expect(live.previewWork(new AbortController().signal, async () => true)).rejects.toMatchObject({ code: "PREVIEW_BUSY" });
  const active = runner.previewWork(new AbortController().signal, signal => new Promise<void>((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
  const rejected = expect(active).rejects.toMatchObject({ code: "PREVIEW_BUSY" }); await expect(runner.previewWork(new AbortController().signal, async () => true)).rejects.toMatchObject({ code: "PREVIEW_BUSY" }); runner.cancelPreview(); await rejected;
});
it("isolates relay mailboxes, rejects oversized chunks and releases cancelled requests", async () => {
  const first = command("status"); const waiting = requestPreview(first); expect(pollPreview("other_device")).toEqual([]); const [pending] = pollPreview(target.agentId);
  await expect(acceptPreview("other_device", pending.id, new Request("http://local", { method: "POST", body: "x" }))).rejects.toMatchObject({ status: 410 });
  await acceptPreview(target.agentId, pending.id, new Request("http://local", { method: "POST", body: new Uint8Array([1, 2, 3]) })); expect((await waiting).bytes).toEqual(new Uint8Array([1, 2, 3]));
  const oversized = requestPreview(command("bytes")); const failed = expect(oversized).rejects.toMatchObject({ code: "PREVIEW_RESPONSE" }); const [large] = pollPreview(target.agentId);
  await expect(acceptPreview(target.agentId, large.id, new Request("http://local", { method: "POST", body: new Uint8Array(PREVIEW_CHUNK + 1) }))).rejects.toMatchObject({ status: 413 }); await failed;
  const abort = new AbortController(); const cancelled = requestPreview(command("status"), abort.signal); const rejected = expect(cancelled).rejects.toMatchObject({ code: "PREVIEW_CANCELLED" }); abort.abort(); await rejected; expect(pollPreview(target.agentId)).toEqual([]);
});
