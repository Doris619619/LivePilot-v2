/** 发布包接入上传核心的回归；合成端口模拟，真实文件和加密检查点验证最终大小与恢复绑定。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PublishingRunner } from "@/core/publishing/runner";
import { PublishingStore } from "@/core/publishing/storage";
import { seal, unseal } from "@/core/storage";
import { publishingMetadata } from "@/core/publishing/metadata";
import { AppError } from "@/core/errors";
import { fixtureApi, fixtureJob } from "./publishing-fixtures";
import type { JobSpec, MediaAsset } from "@/shared/publishing";
const media = vi.hoisted(() => ({ prepare: vi.fn(), validate: vi.fn(), check: vi.fn() }));
vi.mock("@/core/publishing/render", () => ({ preparePackageUpload: media.prepare, validatePreparedUpload: media.validate }));
vi.mock("@/core/publishing/packages", async importOriginal => ({ ...await importOriginal<typeof import("@/core/publishing/packages")>(), validatePackage: media.check }));
let root: string; let store: PublishingStore; let job: JobSpec; let final: { asset: MediaAsset; relativePath: string; sha256: string }; let now: number;
/** 独立目录、合成音乐包和小输出，不访问真实工具或频道。 */
beforeEach(async () => {
  media.prepare.mockReset(); media.validate.mockReset(); media.check.mockReset().mockResolvedValue(undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "publishing-package-runner-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_PUBLISHING_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  store = new PublishingStore(path.join(root, "state")); now = Date.parse("2026-10-02T00:00:00Z");
  job = fixtureJob(); job.contentPackage = { id: "c".repeat(64), batchName: "Batch", name: "001", version: "d".repeat(64), sourceVideo: job.asset, sourceMusic: { ...job.asset, filename: "music.mp3" }, validationState: "valid", issues: [] };
  const bytes = Buffer.alloc(500, 7); const file = path.join(root, "Working", "output.mp4"); await mkdir(path.dirname(file)); await writeFile(file, bytes);
  final = { asset: { ...job.asset, filename: "output.mp4", size: bytes.length, mtimeMs: (await stat(file)).mtimeMs, version: "e".repeat(64) }, relativePath: "Working/output.mp4", sha256: createHash("sha256").update(bytes).digest("hex") };
  media.prepare.mockResolvedValue(final); media.validate.mockResolvedValue({ file, sha256: final.sha256 });
});
/** 只移除当前测试创建的临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-package-runner-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 等待后台检查点，超过界限视作执行未安全结束。 */
async function settle(runner: PublishingRunner) { for (let i = 0; i < 300 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(runner.busy).toBe(false); }
it("starts the session with final output bytes rather than source bytes and persists preparation", async () => {
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api });
  await runner.apply(job); await runner.tick(); await settle(runner);
  expect(api.begin).toHaveBeenCalledWith(expect.objectContaining({ asset: expect.objectContaining({ size: 500 }) }), "LiveNest upload " + job.id); expect(api.chunk.mock.calls[0][3]).toBe(500);
  expect((await runner.reports())[0]).toMatchObject({ total: 500, offset: 500, prepared: { size: 500, sha256: final.sha256 }, videoId: "video_one" });
  const saved = unseal<{ spec: JobSpec; finalUpload: typeof final }[]>(await readFile(path.join(store.dir, "entries.enc"), "utf8"));
  expect(saved[0].spec.asset.size).toBe(job.asset.size); expect(saved[0].finalUpload).toEqual(final); await runner.stop();
});
it("restarts a generated-file session without rendering or inserting again", async () => {
  const { api } = fixtureApi(); await store.write("entries.enc", seal([{ spec: job, finalUpload: final, sha256: final.sha256, session: "old", report: { id: job.id, revision: 1, sequence: 5, state: "uploading", offset: 200, total: 500, prepared: { size: 500, version: final.asset.version, sha256: final.sha256 }, updatedAt: now, metadata: { title: "001", description: "" } }, playlistsDone: [], failures: 0 }]));
  api.probe.mockResolvedValue({ offset: 300 }); const runner = new PublishingRunner(new Map(), { store, now: () => now, api: () => api }); await runner.tick(); await settle(runner);
  expect(media.prepare).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); expect(api.probe).toHaveBeenCalledWith("old", 500); expect(api.chunk.mock.calls[0][2]).toBe(300); await runner.stop();
});
it("does not send bytes until Cloud acknowledges the prepared final size", async () => {
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store, api: () => api, requirePreparedAcknowledgement: true });
  await runner.apply(job); await runner.tick();
  let report = (await runner.reports())[0];
  for (let i = 0; i < 100 && !report.prepared; i++) { await new Promise(resolve => setTimeout(resolve, 5)); report = (await runner.reports())[0]; }
  expect(report).toMatchObject({ total: 500, offset: 0, prepared: { size: 500 } }); expect(api.begin).not.toHaveBeenCalled();
  await runner.acknowledge([{ id: job.id, sequence: report.sequence }]); await settle(runner); expect(api.begin).toHaveBeenCalledOnce(); await runner.stop();
});
it("does not treat an obsolete prepared-report acknowledgement as confirmation of a new revision", async () => {
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store, api: () => api, requirePreparedAcknowledgement: true });
  await runner.apply(job); await runner.tick(); let prepared = (await runner.reports())[0];
  for (let i = 0; i < 100 && !prepared.prepared; i++) { await new Promise(resolve => setTimeout(resolve, 5)); prepared = (await runner.reports())[0]; }
  expect(prepared.prepared).toBeDefined();
  await runner.apply({ ...job, revision: 2, desired: "pause" }); await runner.apply({ ...job, revision: 3 });
  await runner.acknowledge([{ id: job.id, sequence: prepared.sequence }]); await new Promise(resolve => setTimeout(resolve, 70)); await runner.tick(); expect(api.begin).not.toHaveBeenCalled();
  const current = (await runner.reports())[0]; expect(current.revision).toBe(3); await runner.acknowledge([{ id: job.id, sequence: current.sequence }]); await settle(runner);
  expect(api.begin).toHaveBeenCalledOnce(); await runner.stop();
});
it("refuses a package session whose final-file checkpoint was lost", async () => {
  const { api } = fixtureApi(); await store.write("entries.enc", seal([{ spec: job, session: "old", report: { id: job.id, revision: 1, sequence: 1, state: "uploading", offset: 0, total: job.asset.size, updatedAt: now }, playlistsDone: [], failures: 0 }]));
  const runner = new PublishingRunner(new Map(), { store, api: () => api }); await runner.tick(); await settle(runner);
  expect(media.prepare).not.toHaveBeenCalled(); expect(api.begin).not.toHaveBeenCalled(); expect((await runner.reports())[0].state).toBe("needs_attention"); await runner.stop();
});
it("stops before the next chunk when the confirmed source package changed", async () => {
  media.check.mockRejectedValue(new AppError("ASSET_CHANGED", "发布包已改变"));
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store, api: () => api });
  await runner.apply(job); await runner.tick(); await settle(runner);
  expect(api.chunk).not.toHaveBeenCalled(); expect(api.begin).toHaveBeenCalledOnce();
  expect((await runner.reports())[0]).toMatchObject({ state: "needs_attention", offset: 0 }); await runner.stop();
});
it("keeps the existing video association and stops finalization after a source change", async () => {
  media.check.mockRejectedValue(new AppError("ASSET_CHANGED", "发布包已改变"));
  await store.write("entries.enc", seal([{ spec: job, finalUpload: final, report: { id: job.id, revision: 1, sequence: 5, state: "finalizing", offset: 500, total: 500, videoId: "video_one", updatedAt: now, metadata: { title: "001", description: "" } }, playlistsDone: [], failures: 0 }]));
  const { api } = fixtureApi(); const runner = new PublishingRunner(new Map(), { store, api: () => api }); await runner.tick(); await settle(runner);
  expect(api.begin).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled(); expect((await runner.reports())[0]).toMatchObject({ state: "needs_attention", videoId: "video_one" }); await runner.stop();
});
it("uses package text before AI and keeps manual title precedence", async () => {
  job.profile.ai.enabled = true; job.consent.ai = true; job.contentPackage!.title = "包内标题"; job.contentPackage!.description = "包内说明"; job.overrides.title = "人工标题";
  expect(await publishingMetadata(store, job)).toEqual({ copy: { title: "人工标题", description: "包内说明" }, source: "override" });
  job.profile.ai.enabled = false; job.overrides = {}; delete job.contentPackage!.title; delete job.contentPackage!.description; job.profile.titleTemplate = "{{batchName}} / {{packageName}}";
  expect((await publishingMetadata(store, job)).copy.title).toBe("Batch / 001");
});
