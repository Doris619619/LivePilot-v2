/** 本地 Agent 日志测试：断线继续、重复接收及重启不重放。 */
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Worker } from "@/agent/worker";
import { Store } from "@/core/storage";
import { taskSchema, type RemoteTask } from "@/shared/remote";
let dir: string;
/** 使用独立的临时加密日志。 */
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-agent-")); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); });
/** 删除本测试明确创建的临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("livepilot-agent-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
/** 指令仅包含白名单动作，没有 shell、远程 URL 或绝对路径。 */
function task(): RemoteTask { return taskSchema.parse({ protocol: 1, id: randomUUID(), agentId: "studio_a", instanceId: "main", actor: "alice", expiresAt: Date.now() + 60_000, payload: { kind: "control", input: { action: "stop" } } }); }
it("continues accepted work without any cloud transport and deduplicates simultaneous delivery", async () => {
  let finish!: () => void; const execute = vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  const worker = new Worker(new Store(dir), execute); const value = task();
  await Promise.all([worker.receive(value), worker.receive(value)]); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect((await worker.reports())[0].status).toBe("running"); finish(); await worker.drain();
  expect((await worker.reports())[0].status).toBe("succeeded"); await worker.receive(value); expect(execute).toHaveBeenCalledOnce();
  await worker.acknowledge([value.id]); expect(await worker.reports()).toEqual([]);
});
it("does not execute first-delivered expired commands", async () => {
  const execute = vi.fn(); const worker = new Worker(new Store(dir), execute); const value = task(); value.expiresAt = Date.now() - 1;
  await worker.receive(value); await worker.drain(); expect(execute).not.toHaveBeenCalled(); expect((await worker.reports())[0].status).toBe("expired");
});
it("reports a previous process operation interrupted and never replays it", async () => {
  const { seal } = await import("@/core/storage"); const value = task(); const store = new Store(dir);
  await store.write(value.id + ".json", seal({ task: value, owner: "previous-process", report: { id: value.id, status: "running" } }));
  const execute = vi.fn(); const worker = new Worker(store, execute); await worker.receive(value);
  expect((await worker.reports())[0].status).toBe("interrupted"); expect(execute).not.toHaveBeenCalled();
});
it("runs independent instances concurrently and strips upstream errors", async () => {
  let finish!: () => void; const a = task(); const b = task(); b.instanceId = "second";
  const execute = vi.fn((value: RemoteTask) => value.instanceId === "main" ? new Promise(resolve => { finish = () => resolve(true); }) : Promise.reject(new Error("SECRET_UPSTREAM_TOKEN")));
  const worker = new Worker(new Store(dir), execute); await worker.receive(a); await worker.receive(b);
  await vi.waitFor(async () => expect((await worker.reports()).find(r => r.id === b.id)?.status).toBe("failed"));
  expect(JSON.stringify(await worker.reports())).not.toContain("SECRET_UPSTREAM_TOKEN"); finish(); await worker.drain();
});
it("drains tasks whose initial acceptance write is still pending", async () => {
  const store = new Store(dir); const originalWrite = store.write.bind(store); let accept!: () => void; let finish!: () => void;
  vi.spyOn(store, "write").mockImplementationOnce(async (name, value) => { await new Promise<void>(resolve => { accept = resolve; }); await originalWrite(name, value); });
  const execute = vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  const worker = new Worker(store, execute); const received = worker.receive(task());
  await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
  let drained = false; const draining = worker.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); accept(); await received;
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce()); expect(drained).toBe(false);
  finish(); await draining; expect((await worker.reports())[0].status).toBe("succeeded");
});

/** 执行成功后磁盘失效：内存健康问题可达心跳，且原任务不重新执行。 */
it("reports a failed final save without replaying a successful task",async()=>{const store=new Store(dir);const original=store.write.bind(store);let count=0;vi.spyOn(store,"write").mockImplementation(async(name,value)=>{if(++count>=3)throw Object.assign(new Error("PRIVATE PATH"),{code:"ENOSPC"});await original(name,value);});const execute=vi.fn(async()=>({ok:true}));const worker=new Worker(store,execute);const value=task();await worker.receive(value);await vi.waitFor(()=>expect(worker.problems.get(value.id)).toMatchObject({code:"RESULT_SAVE",target:{instanceId:"main"},attemptId:value.id}));await worker.receive(value);expect(execute).toHaveBeenCalledOnce();expect(JSON.stringify([...worker.problems.values()])).not.toContain("PRIVATE");});

/** 重新配对后旧任务仍留在原日志中，不上传或确认到新设备。 */
it("keeps old-identity reports local after re-pairing", async () => {
  const store = new Store(dir); const old = new Worker(store, async () => ({ ok: true }), "studio_a"); const value = task();
  await old.receive(value); await old.drain();
  const fresh = new Worker(store, vi.fn(), "studio_b"); expect(await fresh.reports()).toEqual([]);
  expect((await old.reports()).map(r => r.id)).toEqual([value.id]);
});

it("cleans one publishing account without waiting for or deleting host live work and another account", async () => {
  const id = randomUUID(); const other = randomUUID(); const live = task(); const accountTask = { ...task(), payload: { kind: "publishing-account-oauth-begin" as const, accountId: id } }; const otherTask = { ...task(), payload: { kind: "publishing-account-playlists" as const, accountId: other } };
  let finishLive!: () => void; const worker = new Worker(new Store(dir), async value => value.id === live.id ? new Promise<void>(resolve => { finishLive = resolve; }) : { ok: true });
  await worker.receive(live); await worker.receive(accountTask); await worker.receive(otherTask); await vi.waitFor(() => expect(finishLive).toBeTypeOf("function"));
  await worker.purgeYouTube("main", id); expect(await new Store(dir).read(accountTask.id + ".json")).toBeNull(); expect(await new Store(dir).read(live.id + ".json")).not.toBeNull(); expect(await new Store(dir).read(otherTask.id + ".json")).not.toBeNull();
  finishLive(); await worker.drain(); await worker.purgeYouTube("main"); expect(await new Store(dir).read(live.id + ".json")).toBeNull(); expect(await new Store(dir).read(otherTask.id + ".json")).not.toBeNull();
});
