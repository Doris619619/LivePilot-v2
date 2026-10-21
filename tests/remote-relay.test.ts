/** 素材中转集成测试：用真实 Agent 上传实现模拟跨网络分片与响应丢失恢复。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, heartbeatAgent } from "@/cloud/agents";
import { enqueue, pollTasks, reportTasks, rpc } from "@/cloud/tasks";
import { relayChunk, downloadSlot } from "@/cloud/relay";
import { createUpload, uploadStatus, uploadChunk, prepareFinish, finishUpload } from "@/core/uploads";
import { cloudStore } from "@/cloud/store";
import { sleep } from "@/core/errors";
import type { UploadStatus } from "@/shared/uploads";
let dir: string; let media: string; let cancellation: AbortController;
const workers = new Set<Promise<void>>(), pendingWork = new Set<Promise<unknown>>();
const target = { agentId: "studio_a", instanceId: "main" };
/** 各测试分别持有虚拟云端和真实临时媒体库。 */
beforeEach(async ({ signal }) => {
  const controller = new AbortController(); cancellation = controller; signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-relay-")); media = path.join(dir, "media"); await mkdir(path.join(media, "videos"), { recursive: true }); await mkdir(path.join(media, "music"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(dir, "data")); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", media); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  const pairing = await createPairing("studio_a", "A"); await pairAgent("studio_a", pairing.code, "b".repeat(64)); const session = await openSession("studio_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("studio_a", session.session, []);
});
/** 先停止并排空本例泵及RPC，超时也不先切换环境；取消回报只作用于本例隔离设备的任务。 */
afterEach(async () => {
  cancellation.abort(new Error("Synthetic fixture stopped")); await Promise.allSettled(workers); workers.clear();
  // 生产RPC保留45秒期限；测试取消用真实失败回报唤醒等待者，不留下45秒后台Promise。
  const deadline = Date.now() + 50_000;
  while (pendingWork.size && Date.now() < deadline) {
    const tasks = await pollTasks(target.agentId);
    if (tasks.length) await reportTasks(target.agentId, tasks.map(task => ({ id: task.id, status: "failed" as const, error: "Synthetic fixture cancelled", httpStatus: 409 })));
    await Promise.race([Promise.allSettled([...pendingWork]), sleep(25)]);
  }
  if (pendingWork.size) throw new Error("Synthetic relay work did not drain; temporary data and environment retained");
  vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-relay-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true });
}, 60_000);
/** 使用真实上传函数处理收到的白名单任务，不做 OBS 操作。 */
async function pump(signal: AbortSignal) {
  while (!signal.aborted) {
    for (const task of await pollTasks("studio_a")) {
      if (signal.aborted) return;
      const p = task.payload; let result: unknown;
      if (p.kind === "upload-status") result = await uploadStatus(task.instanceId, task.actor, p.uploadId);
      else if (p.kind === "upload-chunk") {
        const response = await downloadSlot("studio_a", p.slot);
        const req = new Request("http://127.0.0.1/chunk", { method: "PUT", body: response.body, duplex: "half" } as RequestInit);
        result = await uploadChunk(task.instanceId, task.actor, p.uploadId, p.offset, p.hash, req);
      } else continue;
      await reportTasks("studio_a", [{ id: task.id, status: "succeeded", result }]);
    }
    // 与真实 Agent/云端长轮询一致使用500ms间隔，避免10ms虚拟空轮询持续抢占写锁。
    await sleep(500);
  }
}
/** 创建时就订阅两条Promise的失败；泵失败立即失败本例，afterEach仍能取消并排空原RPC。 */
async function withPump<T>(action: (signal: AbortSignal) => Promise<T>) {
  const signal = cancellation.signal, loop = pump(signal); workers.add(loop); void loop.catch(() => {});
  const work = Promise.resolve().then(() => action(signal)); pendingWork.add(work);
  void work.then(() => pendingWork.delete(work), () => pendingWork.delete(work));
  return Promise.race([work, loop.then(() => { throw signal.reason || new Error("Synthetic relay pump stopped before work completed"); })]);
}
it("acknowledges only bytes written on Agent and survives a repeated chunk", async () => {
  const bytes = Buffer.alloc(32_000, 7); const hash = createHash("sha256").update(bytes).digest("hex"); const fingerprint = createHash("sha256").update(hash).digest("hex");
  const record = await createUpload("main", "alice", { kind: "videos", filename: "sample.mp4", size: bytes.length, fingerprint });
  await withPump(async signal => {
    const first = await relayChunk(target, "alice", record.id, 0, hash, new Request("http://127.0.0.1/upload", { method: "PUT", body: bytes, signal })); signal.throwIfAborted();
    expect(first.received).toBe(bytes.length); expect(first.agentId).toBe("studio_a");
    const retry = await relayChunk(target, "alice", record.id, 0, hash, new Request("http://127.0.0.1/upload", { method: "PUT", body: bytes, signal })); signal.throwIfAborted(); expect(retry.received).toBe(bytes.length);
    await prepareFinish("main", "alice", record.id); const complete = await finishUpload("main", "alice", record.id);
    expect(await readFile(path.join(media, "videos", complete.publishedName!))).toEqual(bytes);
    expect(await cloudStore().read("relay.json")).toEqual([]);
  });
}, 20_000);
it("drains its pending RPC after the Agent pump rejects a foreign upload actor", async () => {
  const record = await createUpload("main", "alice", { kind: "videos", filename: "sample.mp4", size: 1, fingerprint: "a".repeat(64) });
  await expect(withPump(() => rpc<UploadStatus>(target, "bob", { kind: "upload-status", uploadId: record.id }))).rejects.toMatchObject({ code: "UPLOAD", status: 404 });
  // pump已失败，但真实Cloud RPC仍在等结果；afterEach必须先回报取消并排空，再换环境和清理目录。
}, 20_000);
it("refuses foreign devices downloading a retained relay slot", async () => {
  const id = randomUUID(); await cloudStore().write("relay.json", [{ ...target, id, actor: "alice", ready: true, size: 1, expires: Date.now() + 60_000 }]);
  await expect(downloadSlot("studio_b", id)).rejects.toMatchObject({ status: 404 });
});
it("does not report success before Agent replies and preserves upload actor isolation", async () => {
  const record = await createUpload("main", "alice", { kind: "videos", filename: "sample.mp4", size: 1, fingerprint: "a".repeat(64) });
  await expect(uploadStatus("main", "bob", record.id)).rejects.toMatchObject({ status: 404 });
  const task = await enqueue(target, "alice", { kind: "upload-status", uploadId: record.id }); expect(task.status).toBe("queued");
  await withPump(async signal => { const result = await rpc<UploadStatus>(target, "alice", { kind: "upload-status", uploadId: record.id }); signal.throwIfAborted(); expect(result.received).toBe(0); });
}, 20_000);
