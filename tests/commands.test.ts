/** 隔离磁盘的命令受理测试；真实直播边界全部替换为可控依赖。 */
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Commands } from "@/server/commands";
import { Store } from "@/server/storage";
import type { Control } from "@/server/control";
let dir: string; let storage: Store; let commands: Commands;
let control: { busy: boolean; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn>; clearUncertain: ReturnType<typeof vi.fn> };
/** 命令测试仅调用 mock，不启动 OBS。 */
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-commands-")); vi.stubEnv("LIVEPILOT_ACCESS_DIR", path.join(dir, "access"));
  storage = new Store(path.join(dir, "commands"));
  control = { busy: false, start: vi.fn(), stop: vi.fn(), launch: vi.fn(), clearUncertain: vi.fn() };
  commands = new Commands(storage, control as unknown as Control, "main", vi.fn());
});
/** 不触碰仓库内的直播状态。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("livepilot-commands-")) throw new Error("Unsafe cleanup"); await rm(dir, { recursive: true, force: true }); });
it("persists acceptance and executes an identical repeated request once", async () => {
  const input = { instanceId: "main", requestId: randomUUID(), action: "stop" as const };
  const first = await commands.accept(input, "alice");
  expect(first.operation.status).toBe("accepted");
  expect(control.stop).not.toHaveBeenCalled();
  expect((await commands.accept(input, "alice")).operation.id).toBe(first.operation.id);
  await commands.run(first.operation.id);
  await commands.run(first.operation.id);
  expect(control.stop).toHaveBeenCalledOnce();
  expect((await commands.latest())?.status).toBe("succeeded");
});
it("rejects conflicts before an accepted operation starts", async () => {
  const input = { instanceId: "main", requestId: randomUUID(), action: "start" as const };
  await commands.accept(input, "alice");
  await expect(commands.accept({ ...input, requestId: randomUUID() }, "bob")).rejects.toMatchObject({ status: 409 });
  await expect(commands.accept({ ...input, action: "stop" }, "alice")).rejects.toMatchObject({ status: 409 });
  await expect(commands.withIdle(async () => "oauth")).rejects.toMatchObject({ status: 409 });
});
it("retains real running and failure states independently of a browser request", async () => {
  let finish!: () => void;
  control.stop.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const { operation } = await commands.accept({ instanceId: "main", requestId: randomUUID(), action: "stop" }, "alice");
  const task = commands.run(operation.id);
  await commands.run(operation.id);
  await vi.waitFor(() => expect(control.stop).toHaveBeenCalledOnce());
  expect((await commands.latest())?.status).toBe("running");
  finish(); await task;
  expect((await commands.latest())?.status).toBe("succeeded");
});
it("marks a previous process operation interrupted and never replays it", async () => {
  const id = randomUUID();
  await storage.write(id + ".json", { id, owner: "old-process", actor: "alice", action: "start", status: "running" });
  await storage.write("latest.json", { id });
  expect((await commands.latest())?.status).toBe("interrupted");
  expect(control.start).not.toHaveBeenCalled();
});
