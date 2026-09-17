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
let dir: string; let media: string;
const target = { agentId: "studio_a", instanceId: "main" };
/** 各测试分别持有虚拟云端和真实临时媒体库。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-relay-")); media = path.join(dir, "media"); await mkdir(path.join(media, "videos"), { recursive: true }); await mkdir(path.join(media, "music"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(dir, "data")); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", media); vi.stubEnv("LIVEPILOT_INSTANCES", "main"); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  const pairing = await createPairing("studio_a", "A"); await pairAgent("studio_a", pairing.code, "b".repeat(64)); const session = await openSession("studio_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("studio_a", session.session, []);
});
/** 中转文件与源素材只在临时目录内清理。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-relay-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 使用真实上传函数处理收到的白名单任务，不做 OBS 操作。 */
async function pump(until: () => boolean) {
  while (!until()) {
    for (const task of await pollTasks("studio_a")) {
      const p = task.payload; let result: unknown;
      if (p.kind === "upload-status") result = await uploadStatus(task.instanceId, task.actor, p.uploadId);
      else if (p.kind === "upload-chunk") {
        const response = await downloadSlot("studio_a", p.slot);
        const req = new Request("http://127.0.0.1/chunk", { method: "PUT", body: response.body, duplex: "half" } as RequestInit);
        result = await uploadChunk(task.instanceId, task.actor, p.uploadId, p.offset, p.hash, req);
      } else continue;
      await reportTasks("studio_a", [{ id: task.id, status: "succeeded", result }]);
    }
    await sleep(10);
  }
}
it("acknowledges only bytes written on Agent and survives a repeated chunk", async () => {
  const bytes = Buffer.alloc(32_000, 7); const hash = createHash("sha256").update(bytes).digest("hex"); const fingerprint = createHash("sha256").update(hash).digest("hex");
  const record = await createUpload("main", "alice", { kind: "videos", filename: "sample.mp4", size: bytes.length, fingerprint });
  let done = false; const loop = pump(() => done);
  try {
    const first = await relayChunk(target, "alice", record.id, 0, hash, new Request("http://127.0.0.1/upload", { method: "PUT", body: bytes }));
    expect(first.received).toBe(bytes.length); expect(first.agentId).toBe("studio_a");
    const retry = await relayChunk(target, "alice", record.id, 0, hash, new Request("http://127.0.0.1/upload", { method: "PUT", body: bytes })); expect(retry.received).toBe(bytes.length);
    await prepareFinish("main", "alice", record.id); const complete = await finishUpload("main", "alice", record.id);
    expect(await readFile(path.join(media, "videos", complete.publishedName!))).toEqual(bytes);
    expect(await cloudStore().read("relay.json")).toEqual([]);
  } finally { done = true; await loop; }
});
it("refuses foreign devices downloading a retained relay slot", async () => {
  const id = randomUUID(); await cloudStore().write("relay.json", [{ ...target, id, actor: "alice", ready: true, size: 1, expires: Date.now() + 60_000 }]);
  await expect(downloadSlot("studio_b", id)).rejects.toMatchObject({ status: 404 });
});
it("does not report success before Agent replies and preserves upload actor isolation", async () => {
  const record = await createUpload("main", "alice", { kind: "videos", filename: "sample.mp4", size: 1, fingerprint: "a".repeat(64) });
  await expect(uploadStatus("main", "bob", record.id)).rejects.toMatchObject({ status: 404 });
  const task = await enqueue(target, "alice", { kind: "upload-status", uploadId: record.id }); expect(task.status).toBe("queued");
  let done = false; const loop = pump(() => done);
  try { const result = await rpc<UploadStatus>(target, "alice", { kind: "upload-status", uploadId: record.id }); expect(result.received).toBe(0); } finally { done = true; await loop; }
});
