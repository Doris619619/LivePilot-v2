/** 文件锁回归：真实跨进程互斥、Windows 删除挂起及 ACL 拒绝；不调用外部平台。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, open, lstat, symlink, unlink } from "node:fs/promises";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { AppError } from "../src/core/errors";
import { Store, LockBusyError } from "../src/core/storage";
import { transaction } from "../src/cloud/store";
const controls = vi.hoisted(() => ({ beforeCreate: undefined as undefined | ((filename: string) => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    /** 只协调测试中的 wx 时序；错误仍由真实文件系统产生。 */
    open: async (...args: Parameters<typeof actual.open>) => { if (args[1] === "wx") await controls.beforeCreate?.(String(args[0])); return actual.open(...args); },
    unlink: vi.fn(actual.unlink),
  };
});
const execute = promisify(execFile);
let root: string; const children = new Set<ChildProcessWithoutNullStreams>();
/** 所有锁、子进程和权限变更只作用于每例新建的直接临时目录。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-storage-locks-")); controls.beforeCreate = undefined; });
/** 子进程正常释放自己的句柄；不删除他人的锁来使测试通过。 */
afterEach(async () => {
  controls.beforeCreate = undefined;
  for (const child of children) { child.stdin.on("error", () => {}); child.stdin.end(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); }); }
  children.clear();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-storage-locks-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
});
/** 启动仅操作本例锁的原生 Windows owner，通过显式握手进入 delete-pending。 */
async function pendingOwner(filename: string) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests/fixtures/windows-delete-pending.ps1"), filename], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
  let output = "", error = ""; const waits = new Set<{ word: string; resolve(): void; reject(error: Error): void }>();
  child.stdout.on("data", bytes => { output += bytes.toString(); for (const item of waits) if (output.includes(item.word)) { waits.delete(item); item.resolve(); } });
  child.stderr.on("data", bytes => { error += bytes.toString(); });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { children.delete(child); if (code) reject(new Error("Native fixture failed: " + error)); else resolve(); for (const item of waits) item.reject(new Error("Native fixture ended before " + item.word)); }); });
  /** 只等待固定测试标记，不读取真实进程或服务日志。 */
  const wait = (word: string) => output.includes(word) ? Promise.resolve() : new Promise<void>((resolve, reject) => waits.add({ word, resolve, reject }));
  await wait("held");
  return { child, exited, wait, release: () => child.stdin.end("release\n") };
}
it("keeps direct exclusive calls immediate and serializes 100 local transactions without losing writes", async () => {
  const store = new Store(root); let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = store.exclusive(async () => { entered(); await blocked; }); await ready;
  await expect(new Store(root).exclusive(async () => {})).rejects.toBeInstanceOf(LockBusyError); release(); await first;
  await Promise.all(Array.from({ length: 100 }, () => transaction(new Store(root), async () => { const state = await store.read<{ count: number }>("counter.json"); await store.write("counter.json", { count: (state?.count || 0) + 1 }); })));
  expect(await store.read("counter.json")).toEqual({ count: 100 }); await expect(lstat(path.join(root, "metadata.lock"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);
it("does not retry a business BUSY thrown inside the transaction", async () => {
  const busy = new AppError("BUSY", "business condition", 409), run = vi.fn(async () => { throw busy; });
  await expect(transaction(new Store(root), run)).rejects.toBe(busy); expect(run).toHaveBeenCalledOnce();
});
it.each(["empty", "corrupt", "valid-pid", "directory", "junction"])("preserves the original EPERM for a %s lock without delete-pending proof", async kind => {
  const filename = path.join(root, "metadata.lock");
  if (["empty", "corrupt", "valid-pid"].includes(kind)) await writeFile(filename, kind === "empty" ? "" : kind === "valid-pid" ? String(process.pid) : "not-a-pid");
  else if (kind === "directory") await mkdir(filename);
  else { const target = path.join(root, "original"); await mkdir(target); await symlink(target, filename, process.platform === "win32" ? "junction" : "dir"); }
  const denied = Object.assign(new Error("synthetic create denial"), { code: "EPERM" }); controls.beforeCreate = async name => { if (name === filename) throw denied; };
  const store = new Store(root), attempt = vi.spyOn(store, "exclusive"), run = vi.fn();
  const error = await transaction(store, run).catch(value => value);
  expect(run).not.toHaveBeenCalled(); expect(attempt).toHaveBeenCalledOnce();
  expect(error).toBe(denied);
  expect(await lstat(filename)).toBeDefined();
});
it("retries an existing lock while its owner has not yet written the PID", async () => {
  const filename = path.join(root, "metadata.lock"), owner = await open(filename, "wx"), run = vi.fn(async () => "released");
  const waiting = transaction(new Store(root), run);
  await new Promise(resolve => setTimeout(resolve, 35)); expect(run).not.toHaveBeenCalled();
  await owner.writeFile(String(process.pid)); await owner.close(); await unlink(filename);
  await expect(waiting).resolves.toBe("released"); expect(run).toHaveBeenCalledOnce();
});
it.runIf(process.platform === "win32")("retries only a real delete-pending lock and closes the observer before the next create", async () => {
  const filename = path.join(root, "metadata.lock"), owner = await pendingOwner(filename); const store = new Store(root), run = vi.fn(async () => "done");
  controls.beforeCreate = async name => {
    if (name !== filename) return; controls.beforeCreate = undefined;
    owner.child.stdin.write("delete\n"); await owner.wait("pending"); setTimeout(owner.release, 45);
  };
  await expect(transaction(store, run)).resolves.toBe("done"); await owner.exited;
  expect(run).toHaveBeenCalledOnce(); expect(vi.mocked(unlink).mock.calls.filter(call => String(call[0]) === filename)).toHaveLength(1);
});
it.runIf(process.platform === "win32")("returns the real EPERM when a proven pending deletion outlives the bounded window", async () => {
  const filename = path.join(root, "metadata.lock"), owner = await pendingOwner(filename), run = vi.fn();
  controls.beforeCreate = async name => { if (name !== filename) return; controls.beforeCreate = undefined; owner.child.stdin.write("delete\n"); await owner.wait("pending"); };
  const started = performance.now(); await expect(transaction(new Store(root), run)).rejects.toMatchObject({ code: "EPERM" });
  expect(performance.now() - started).toBeLessThan(1500); expect(run).not.toHaveBeenCalled(); expect(vi.mocked(unlink).mock.calls.filter(call => String(call[0]) === filename)).toHaveLength(0);
  owner.release(); await owner.exited; await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
});
it.runIf(process.platform === "win32")("preserves a real directory ACL denial instead of retrying it as BUSY", async () => {
  const blocked = path.join(root, "no-create"); await mkdir(blocked);
  const identity = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true }); const sid = /S-1-[0-9-]+/.exec(identity.stdout)?.[0]; if (!sid) throw new Error("Cannot identify synthetic directory ACL owner");
  await execute("icacls.exe", [blocked, "/deny", "*" + sid + ":(OI)(CI)(WD,AD)"], { windowsHide: true });
  try {
    const store = new Store(blocked), attempts = vi.spyOn(store, "exclusive"), run = vi.fn(); const error = await transaction(store, run).catch(value => value);
    expect(error).not.toBeInstanceOf(LockBusyError); expect(error).toMatchObject({ code: expect.stringMatching(/^(EPERM|EACCES)$/) }); expect(attempts).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
  } finally { await execute("icacls.exe", [blocked, "/remove:d", "*" + sid], { windowsHide: true }); }
});
it("keeps independent Node processes mutually exclusive and accounts for every committed write", async () => {
  const script = path.join(root, "worker.cjs");
  await build({ stdin: { contents: `import {Store} from './src/core/storage';import {transaction} from './src/cloud/store';import {open,unlink} from 'node:fs/promises';import path from 'node:path';const store=new Store(process.argv[2]);(async()=>{for(let i=0;i<20;i++)await transaction(store,async()=>{const marker=path.join(store.dir,'critical.marker');const guard=await open(marker,'wx');try{const previous=await store.read('counter.json');await store.write('counter.json',{count:(previous?.count||0)+1});}finally{await guard.close();await unlink(marker);}})})().catch(error=>{console.error(error.code||error.name);process.exitCode=1});`, loader: "ts", resolveDir: process.cwd(), sourcefile: "lock-worker.ts" }, outfile: script, bundle: true, platform: "node", format: "cjs", alias: { "@": path.resolve("src") }, logLevel: "silent" });
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child); let error = ""; child.stderr.on("data", bytes => { error += bytes.toString(); }); child.once("error", reject); child.once("exit", code => { children.delete(child); if (code) reject(new Error("Lock worker failed: " + error)); else resolve(); });
  })));
  expect(await new Store(root).read("counter.json")).toEqual({ count: 120 }); await expect(lstat(path.join(root, "critical.marker"))).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);
