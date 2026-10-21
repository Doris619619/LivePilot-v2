/** 上传准备/受理真实路由与 Cloud/Agent 文件回归；只使用隔离临时库，不调用外部服务。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { POST as prepare, DELETE as close } from "@/app/api/uploads/prepare/route";
import { POST as create } from "@/app/api/uploads/route";
import { DELETE as cancelRoute, GET as statusRoute } from "@/app/api/uploads/[id]/route";
import { accessStore, digest } from "@/server/access";
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, revokeAgent } from "@/cloud/agents";
import { enqueue, pollTasks, reportTasks, readTask } from "@/cloud/tasks";
import { prepareUploadAdmission, closeUploadAdmission } from "@/cloud/upload-admission";
import { CHUNK_SIZE, createUpload, uploadChunk, uploadStatus } from "@/core/uploads";
import { sleep } from "@/core/errors";
import { Store, store, unseal } from "@/core/storage";
import type { UploadPreparation } from "@/shared/upload-admission";
const origin = "http://127.0.0.1:3010", destination = { agentId: "pc_a", instanceId: "main" }, input = { kind: "videos" as const, filename: "original.mp4", size: 8, fingerprint: "a".repeat(64) };
let dir: string;
/** 真实鉴权、设备归属、队列和本机媒体目录，所有失败发生在隔离数据中。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ln-upload-admission-")); await mkdir(path.join(dir, "media", "videos"), { recursive: true }); await mkdir(path.join(dir, "media", "music"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", path.join(dir, "data")); vi.stubEnv("LIVEPILOT_MEDIA_ROOT", path.join(dir, "media")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_INSTANCES", "main");
  await accessStore().write("access.json", { users: ["alice", "bob", "Uadmin"].map(username => ({ username, role: username.startsWith("U") ? "admin" : "customer", revision: "r1", disabled: false })), sessions: Object.fromEntries(["alice", "bob", "Uadmin"].map((username, i) => [digest(String(i + 1).repeat(64)), { username, revision: "r1", expires: Date.now() + 30 * 86400000 }])), attempts: {} });
  const paired = await createPairing("pc_a", "A", "alice"); await pairAgent("pc_a", paired.code, "b".repeat(64)); const session = await openSession("pc_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("pc_a", session.session, []);
});
/** 无后台泵；排空所有路由 Promise 后才清理本例数据。 */
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("ln-upload-admission-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 发送真正的 same-origin Cookie 请求，同时保留旧标签成员校验。 */
function request(body: unknown, member = "alice", method = "POST") { const index = ["alice", "bob", "Uadmin"].indexOf(member) + 1; return new Request(origin + "/api/uploads", { method, headers: { host: "127.0.0.1:3010", origin, "x-livepilot": "1", "content-type": "application/json", cookie: "livepilot_session=" + String(index).repeat(64), "x-livepilot-user": member }, body: JSON.stringify(body) }); }
/** 原上传创建与 Cloud poll/report 对接真实 core 文件；不使用宽松准入 mock。 */
async function deliverCreate(work: Promise<Response>) {
  const result = work.then(value => ({ value }), error => ({ error })); let delivered = false;
  for (let i = 0; i < 100 && !delivered; i++) {
    const tasks = await pollTasks("pc_a");
    for (const task of tasks) {
      if (task.payload.kind !== "upload-create") continue;
      const upload = await createUpload(task.instanceId, task.actor, task.payload.input, task.payload.uploadId); await reportTasks("pc_a", [{ id: task.id, status: "succeeded", result: upload }]); delivered = true;
    }
    if (!delivered) await sleep(25);
  }
  if (!delivered) throw new Error("No upload-create was dispatched"); const completed = await result; if ("error" in completed) throw completed.error; return completed.value;
}
it("rejects empty, unsupported and oversize files before preparation, and allows a valid next file", async () => {
  for (const change of [{ size: 0 }, { size: 20 * 1024 ** 3 + 1 }, { filename: "../a.mp4" }, { filename: "wrong.exe" }]) expect((await prepare(request({ destination, input: { ...input, ...change } }))).status).not.toBe(201);
  expect(await agentStore("pc_a").read("tasks.json")).toBeNull(); expect(await readdir(path.join(dir, "media"))).toEqual(["music", "videos"]);
  const prepared = await (await prepare(request({ destination, input }))).json() as UploadPreparation;
  const response = await deliverCreate(create(request({ ...destination, ...input, requestId: prepared.requestId, preparation: prepared }))); expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ id: prepared.requestId, agentId: "pc_a", kind: "videos" });
});
it("a lost preparation reply creates no Agent files; the next preparation can complete and the orphan can close", async () => {
  const orphan = await (await prepare(request({ destination, input }))).json() as UploadPreparation; // browser never receives this reply
  expect((await agentStore("pc_a").read<{ records: unknown[] }>("tasks.json"))?.records).toEqual([]); expect(await readdir(path.join(dir, "media"))).toEqual(["music", "videos"]);
  const next = await (await prepare(request({ destination, input }))).json() as UploadPreparation; expect(next.requestId).not.toBe(orphan.requestId);
  const response = await deliverCreate(create(request({ ...destination, ...input, requestId: next.requestId, preparation: next }))); expect(response.status).toBe(201);
  expect(await (await close(request({ destination, preparation: orphan }, "alice", "DELETE"))).json()).toEqual({ requestId: orphan.requestId, state: "not-accepted" });
  expect((await create(request({ ...destination, ...input, requestId: orphan.requestId, preparation: orphan }))).status).toBe(409);
});
it("a lost create reply keeps the original accepted ID, actor, file and result through query and queue GC", async () => {
  const prepared = await prepareUploadAdmission("alice", destination, input), response = await deliverCreate(create(request({ ...destination, ...input, requestId: prepared.requestId, preparation: prepared }))); expect(response.status).toBe(201); // reply lost
  const status = await uploadStatus("main", "alice", prepared.requestId); expect(status).toMatchObject({ id: prepared.requestId, fingerprint: input.fingerprint });
  await expect(uploadStatus("main", "bob", prepared.requestId)).rejects.toMatchObject({ status: 404 });
  expect(await closeUploadAdmission("alice", destination, prepared)).toEqual({ requestId: prepared.requestId, state: "accepted" });
  const first = await readTask("pc_a", prepared.requestId); expect(unseal(first!.result!)).toMatchObject({ id: prepared.requestId });
  const queue = (await agentStore("pc_a").read<{ records: unknown[] }>("tasks.json"))!; queue.records = []; await agentStore("pc_a").write("tasks.json", queue);
  await expect(enqueue(destination, "alice", { kind: "upload-create", input, uploadId: prepared.requestId }, prepared.requestId, prepared.credential)).rejects.toMatchObject({ code: "UPLOAD_ADMISSION", status: 409 });
  expect((await closeUploadAdmission("alice", destination, prepared)).state).toBe("accepted"); expect((await uploadStatus("main", "alice", prepared.requestId)).id).toBe(prepared.requestId);
});
it.each([false, true])("serializes same-ID create versus explicit close (create first: %s)", async createFirst => {
  const prepared = await prepareUploadAdmission("alice", destination, input), payload = { kind: "upload-create" as const, input, uploadId: prepared.requestId };
  const runCreate = () => enqueue(destination, "alice", payload, prepared.requestId, prepared.credential), runClose = () => closeUploadAdmission("alice", destination, prepared);
  const results = await Promise.allSettled(createFirst ? [runCreate(), runClose()] : [runClose(), runCreate()]);
  const queued = await readTask("pc_a", prepared.requestId), closed = await closeUploadAdmission("alice", destination, prepared);
  if (queued) { expect(closed.state).toBe("accepted"); expect(results.every(result => result.status === "fulfilled")).toBe(true); }
  else { expect(closed.state).toBe("not-accepted"); expect(results.some(result => result.status === "rejected")).toBe(true); }
});
it("rejects expired credentials, changed input, other actor and downgrade; unknown/GC history is never proof of nonacceptance", async () => {
  const prepared = await prepareUploadAdmission("alice", destination, input), payload = { kind: "upload-create" as const, input, uploadId: prepared.requestId };
  await expect(enqueue(destination, "alice", payload, prepared.requestId)).rejects.toMatchObject({ status: 409 });
  await expect(enqueue(destination, "bob", payload, prepared.requestId, prepared.credential)).rejects.toMatchObject({ status: 403 });
  await expect(enqueue(destination, "alice", { ...payload, input: { ...input, filename: "other.mp4" } }, prepared.requestId, prepared.credential)).rejects.toMatchObject({ status: 409 });
  const clock = vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt + 1); await expect(enqueue(destination, "alice", payload, prepared.requestId, prepared.credential)).rejects.toMatchObject({ status: 409 }); clock.mockRestore();
  const queue = (await agentStore("pc_a").read<{ records: unknown[]; uploadAdmissions: unknown[] }>("tasks.json"))!; queue.uploadAdmissions = []; await agentStore("pc_a").write("tasks.json", queue);
  await expect(closeUploadAdmission("alice", destination, prepared)).rejects.toMatchObject({ status: 409 });
  const legacyId = randomUUID(); expect((await close(request({ destination, preparation: { ...prepared, requestId: legacyId } }, "alice", "DELETE"))).status).toBe(409);
});
it("allows a removed-device member to close only their unaccepted preparation, not another actor's preparation", async () => {
  const prepared = await prepareUploadAdmission("alice", destination, input);
  expect((await close(request({ destination, preparation: prepared }, "bob", "DELETE"))).status).toBe(403);
  expect((await prepare(request({ destination, input }, "bob"))).status).toBe(403);
  await revokeAgent("pc_a");
  expect((await close(request({ destination, preparation: prepared }, "alice", "DELETE"))).status).toBe(200);
});
it("supports local administrators with the same prepare/create/reply-loss/close semantics and rejects customers", async () => {
  vi.stubEnv("LIVEPILOT_MODE", "local"); const local = { instanceId: "main" };
  expect((await prepare(request({ destination: local, input }, "alice"))).status).toBe(403);
  vi.stubEnv("LIVEPILOT_UPLOAD_MAX_BYTES", "4"); expect((await prepare(request({ destination: local, input }, "Uadmin"))).status).toBe(413); vi.stubEnv("LIVEPILOT_UPLOAD_MAX_BYTES", "100");
  const prepared = await (await prepare(request({ destination: local, input }, "Uadmin"))).json() as UploadPreparation;
  const created = await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin")); expect(created.status).toBe(201);
  expect(await uploadStatus("main", "Uadmin", prepared.requestId)).toMatchObject({ id: prepared.requestId });
  expect(await (await close(request({ destination: local, preparation: prepared }, "Uadmin", "DELETE"))).json()).toMatchObject({ state: "accepted" });
});
it("closes only the never-enqueued preparation's orphan activity after an atomic task-write failure", async () => {
  const prepared = await prepareUploadAdmission("alice", destination, input), write = Store.prototype.write;
  const fault = vi.spyOn(Store.prototype, "write").mockImplementation(async function(this: Store, name, value) { if (name === "tasks.json" && (value as { records?: unknown[] }).records?.length) throw new Error("Synthetic atomic queue failure"); return write.call(this, name, value); });
  await expect(enqueue(destination, "alice", { kind: "upload-create", input, uploadId: prepared.requestId }, prepared.requestId, prepared.credential)).rejects.toThrow("Synthetic atomic queue failure"); fault.mockRestore();
  const storage = agentStore("pc_a"), maintenance = (await storage.read<{ activities: Record<string, number> }>("maintenance.json"))!; expect(maintenance.activities["upload:" + prepared.requestId]).toBeGreaterThan(Date.now()); maintenance.activities["upload:unrelated"] = Date.now() + 10000; await storage.write("maintenance.json", maintenance);
  expect((await closeUploadAdmission("alice", destination, prepared)).state).toBe("not-accepted");
  expect((await storage.read<{ activities: Record<string, number> }>("maintenance.json"))!.activities).toEqual({ "upload:unrelated": maintenance.activities["upload:unrelated"] });
  await expect(enqueue(destination, "alice", { kind: "upload-create", input, uploadId: prepared.requestId }, prepared.requestId, prepared.credential)).rejects.toMatchObject({ status: 409 });
  const next = await prepareUploadAdmission("alice", destination, input); expect((await deliverCreate(create(request({ ...destination, ...input, requestId: next.requestId, preparation: next })))).status).toBe(201); expect((await uploadStatus("main", "alice", next.requestId)).id).toBe(next.requestId);
});
it("local cancellation waits for an accepted create before its root-file lock, then fences all late creates", async () => {
  vi.stubEnv("LIVEPILOT_MODE", "local"); const local = { instanceId: "main" }, prepared = await (await prepare(request({ destination: local, input }, "Uadmin"))).json() as UploadPreparation;
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let paused = false;
  const exclusive = Store.prototype.exclusive;
  const fault = vi.spyOn(Store.prototype, "exclusive").mockImplementation(async function(this: Store, fn, name) { if (name === "uploads.lock" && !paused) { paused = true; enter(); await gate; } return exclusive.call(this, fn, name); });
  const creating = create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin")); void creating.catch(() => {}); await entered;
  const cancelRequest = request({}, "Uadmin", "DELETE"); const url = origin + "/api/uploads/" + prepared.requestId + "?instanceId=main";
  let replied = false; const cancelling = cancelRoute(new Request(url, cancelRequest), { params: Promise.resolve({ id: prepared.requestId }) }).then(value => { replied = true; return value; }); void cancelling.catch(() => {});
  try { await sleep(75); expect(replied).toBe(false); } finally { release(); await Promise.allSettled([creating, cancelling]); fault.mockRestore(); }
  expect((await creating).status).toBe(201); expect((await cancelling).status).toBe(200);
  await expect(uploadStatus("main", "Uadmin", prepared.requestId)).rejects.toMatchObject({ status: 404 });
  expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(409);
});
it("local cancel-result persistence failure never permits a late create to resurrect deleted files; retry cancellation converges", async () => {
  vi.stubEnv("LIVEPILOT_MODE", "local"); const local = { instanceId: "main" }, prepared = await (await prepare(request({ destination: local, input }, "Uadmin"))).json() as UploadPreparation;
  expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(201);
  const write = Store.prototype.write;
  const fault = vi.spyOn(Store.prototype, "write").mockImplementation(async function(this: Store, name, value) { const state = (value as { uploadAdmissions?: { state: string }[] }).uploadAdmissions?.[0]?.state; if (name === "upload-admissions.json" && ["rejected", "cancelled"].includes(state || "")) throw new Error("Synthetic final cancellation write failure"); return write.call(this, name, value); });
  const cancel = () => cancelRoute(new Request(origin + "/api/uploads/" + prepared.requestId + "?instanceId=main", request({}, "Uadmin", "DELETE")), { params: Promise.resolve({ id: prepared.requestId }) });
  try {
    expect((await cancel()).status).toBe(500); await expect(uploadStatus("main", "Uadmin", prepared.requestId)).rejects.toMatchObject({ status: 404 });
    expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(409);
  } finally { fault.mockRestore(); }
  expect((await cancel()).status).toBe(200); expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(409);
});
it("a local upload renewed by real chunks remains queryable and cancellable after expired-admission GC", async () => {
  vi.stubEnv("LIVEPILOT_MODE", "local"); const local = { instanceId: "main" }, large = { ...input, size: CHUNK_SIZE * 2 }, initial = Date.now();
  const prepared = await prepareUploadAdmission("Uadmin", local, large); expect((await create(request({ ...local, ...large, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(201);
  const bytes = Buffer.alloc(CHUNK_SIZE, 7), hash = createHash("sha256").update(bytes).digest("hex"), clock = vi.spyOn(Date, "now");
  try {
    clock.mockReturnValue(initial + 6 * 86400000); await uploadChunk("main", "Uadmin", prepared.requestId, 0, hash, new Request(origin, { method: "PUT", body: bytes }));
    clock.mockReturnValue(initial + 9 * 86400000); await uploadChunk("main", "Uadmin", prepared.requestId, CHUNK_SIZE, hash, new Request(origin, { method: "PUT", body: bytes }));
    await prepareUploadAdmission("Uadmin", local, input); expect((await store().read<{ uploadAdmissions: { id: string }[] }>("upload-admissions.json"))!.uploadAdmissions.some(entry => entry.id === prepared.requestId)).toBe(false);
    expect((await uploadStatus("main", "Uadmin", prepared.requestId)).received).toBe(large.size);
    const cancel = () => cancelRoute(new Request(origin + "/api/uploads/" + prepared.requestId + "?instanceId=main", request({}, "Uadmin", "DELETE")), { params: Promise.resolve({ id: prepared.requestId }) });
    expect((await cancel()).status).toBe(200); expect((await cancel()).status).toBe(200);
    await expect(uploadStatus("main", "Uadmin", prepared.requestId)).rejects.toMatchObject({ status: 404 });
    expect((await create(request({ ...local, ...large, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(409);
  } finally { clock.mockRestore(); }
});
it("accepted preparation expiry blocks create replay while original authenticated status/cancel still converge", async () => {
  vi.stubEnv("LIVEPILOT_MODE", "local"); const local = { instanceId: "main" }, prepared = await prepareUploadAdmission("Uadmin", local, input);
  expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(201);
  const clock = vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt + 1), context = { params: Promise.resolve({ id: prepared.requestId }) }, url = origin + "/api/uploads/" + prepared.requestId + "?instanceId=main";
  try {
    expect((await create(request({ ...local, ...input, requestId: prepared.requestId, preparation: prepared }, "Uadmin"))).status).toBe(409);
    const headers = request({}, "Uadmin").headers; expect((await statusRoute(new Request(url, { headers }), context)).status).toBe(200);
    expect((await cancelRoute(new Request(url, request({}, "Uadmin", "DELETE")), context)).status).toBe(200);
    expect((await statusRoute(new Request(url, { headers }), context)).status).toBe(404);
  } finally { clock.mockRestore(); }
});
