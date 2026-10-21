/** 文件锁回归：真实跨进程互斥、Windows 删除挂起及 ACL 拒绝；不调用外部平台。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, open, lstat, symlink, unlink, rename, type FileHandle } from "node:fs/promises";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { AppError } from "../src/core/errors";
import { Store, LockBusyError } from "../src/core/storage";
import { transaction } from "../src/cloud/store";
const controls = vi.hoisted(() => ({
  beforeCreate: undefined as undefined | ((filename: string) => Promise<void>),
  afterCreate: undefined as undefined | ((filename: string, handle: FileHandle) => Promise<void>),
  beforeRename: undefined as undefined | ((filename: string) => Promise<void>),
  beforeUnlink: undefined as undefined | ((filename: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    /** 只协调测试中的 wx 时序；错误仍由真实文件系统产生。 */
    open: async (...args: Parameters<typeof actual.open>) => { if (args[1] === "wx") await controls.beforeCreate?.(String(args[0])); const handle = await actual.open(...args); if (args[1] === "wx") await controls.afterCreate?.(String(args[0]), handle); return handle; },
    /** 只注入合成 owner 的释放时序或原始错误，仍执行真实 rename/unlink。 */
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => { await controls.beforeRename?.(String(args[0])); return actual.rename(...args); }),
    unlink: vi.fn(async (...args: Parameters<typeof actual.unlink>) => { await controls.beforeUnlink?.(String(args[0])); return actual.unlink(...args); }),
  };
});
const execute = promisify(execFile);
let root: string; const children = new Set<ChildProcessWithoutNullStreams>();
/** 所有锁、子进程和权限变更只作用于每例新建的直接临时目录。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-storage-locks-")); controls.beforeCreate = controls.afterCreate = controls.beforeRename = controls.beforeUnlink = undefined; });
/** 子进程正常释放自己的句柄；不删除他人的锁来使测试通过。 */
afterEach(async () => {
  controls.beforeCreate = controls.afterCreate = controls.beforeRename = controls.beforeUnlink = undefined;
  for (const child of children) { child.stdin.on("error", () => {}); child.stdin.end(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); }); }
  children.clear();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-storage-locks-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
});
/** 启动仅操作本例锁的原生 Windows owner，通过显式握手进入 delete-pending。 */
async function pendingOwner(filename: string) {
  const started = performance.now(), seen = new Set<string>();
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests/fixtures/windows-delete-pending.ps1"), filename], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
  process.stdout.write("Native lock fixture: " + JSON.stringify({ phase: "spawn", elapsedMs: 0 }) + "\n");
  let output = "", error = ""; const waits = new Set<{ word: string; resolve(): void; reject(error: Error): void }>();
  /** 只输出合成子进程的阶段耗时，区分 PowerShell/C# 冷启动与真正的锁竞争，不记录路径或凭据。 */
  child.stdout.on("data", bytes => { output += bytes.toString(); for (const phase of ["starting", "compiled", "held", "pending"]) if (output.includes(phase) && !seen.has(phase)) { seen.add(phase); process.stdout.write("Native lock fixture: " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) }) + "\n"); } for (const item of waits) if (output.includes(item.word)) { waits.delete(item); item.resolve(); } });
  child.stderr.on("data", bytes => { error += bytes.toString(); });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { process.stdout.write("Native lock fixture: " + JSON.stringify({ phase: "exit", elapsedMs: Math.round(performance.now() - started), code }) + "\n"); children.delete(child); if (code) reject(new Error("Native fixture failed: " + error)); else resolve(); for (const item of waits) item.reject(new Error("Native fixture ended before " + item.word)); }); });
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
it.each(["empty", "corrupt", "valid-pid", "directory", "junction"])("preserves the original EPERM for a %s lock without guessing ownership", async kind => {
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
it.runIf(process.platform === "win32")("moves its owned lock before cleanup even when observed during the empty PID window", async () => {
  const filename = path.join(root, "control.lock"); let created!: () => void, writePid!: () => void, cleaning!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { created = resolve; }), allowPid = new Promise<void>(resolve => { writePid = resolve; });
  const moved = new Promise<void>(resolve => { cleaning = resolve; }), allowCleanup = new Promise<void>(resolve => { finish = resolve; });
  controls.afterCreate = async name => { if (name === filename) { controls.afterCreate = undefined; created(); await allowPid; } };
  controls.beforeUnlink = async name => { if (name.startsWith(filename + ".") && name.endsWith(".released")) { cleaning(); await allowCleanup; } };
  const owner = new Store(root).exclusive(async () => {}); await ready;
  const observer = await open(filename, "r"); expect((await observer.stat()).size).toBe(0);
  try {
    writePid(); await moved;
    // 旧观察句柄仍然打开，新的 owner 已可原子认领 canonical；旧清理不能碰新锁。
    const next = await open(filename, "wx"); await next.writeFile("new-owner"); finish(); await owner;
    await expect(readFile(filename, "utf8")).resolves.toBe("new-owner");
    expect(vi.mocked(rename).mock.calls.filter(call => String(call[0]) === filename)).toHaveLength(1);
    expect(vi.mocked(unlink).mock.calls.filter(call => String(call[0]) === filename)).toHaveLength(0);
    await next.close(); await unlink(filename);
  } finally { writePid(); finish(); await observer.close(); await owner; }
  expect(await readdir(root)).toEqual([]);
});
it.runIf(process.platform === "win32")("preserves a replacement canonical lock instead of retiring another owner's file", async () => {
  const filename = path.join(root, "control.lock"), original = path.join(root, "original.lock");
  await expect(new Store(root).exclusive(async () => { await rename(filename, original); await writeFile(filename, "replacement-owner"); })).rejects.toMatchObject({ code: "STORAGE" });
  await expect(readFile(filename, "utf8")).resolves.toBe("replacement-owner");
  await expect(readFile(original, "utf8")).resolves.toBe(String(process.pid));
  expect(vi.mocked(unlink)).not.toHaveBeenCalled();
});
it.runIf(process.platform === "win32")("preserves the original release permission error and its canonical lock", async () => {
  const filename = path.join(root, "control.lock"), denied = Object.assign(new Error("synthetic rename denial"), { code: "EPERM", syscall: "rename" });
  controls.beforeRename = async name => { if (name === filename) throw denied; };
  await expect(new Store(root).exclusive(async () => {})).rejects.toBe(denied);
  await expect(readFile(filename, "utf8")).resolves.toBe(String(process.pid)); expect(vi.mocked(unlink)).not.toHaveBeenCalled();
});
it.runIf(process.platform === "win32")("preserves a real delete-pending EPERM and succeeds only after its owner explicitly releases the lock", async () => {
  const filename = path.join(root, "metadata.lock"), owner = await pendingOwner(filename); const store = new Store(root), attempts = vi.spyOn(store, "exclusive"), run = vi.fn(async () => "done");
  controls.beforeCreate = async name => {
    if (name !== filename) return; controls.beforeCreate = undefined;
    owner.child.stdin.write("delete\n"); await owner.wait("pending");
  };
  // 原生 delete-pending 必须保持真实 EPERM；竞争者不能重试成 BUSY 或删除旧 owner 的文件。
  await expect(transaction(store, run)).rejects.toMatchObject({ code: "EPERM", syscall: "open" });
  expect(attempts).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled(); expect(vi.mocked(rename)).not.toHaveBeenCalled(); expect(vi.mocked(unlink)).not.toHaveBeenCalled();
  await expect(lstat(filename)).resolves.toBeDefined(); owner.release(); await owner.exited;
  await vi.waitFor(async () => { await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" }); }, { timeout: 1500, interval: 10 });
  // 只有原 owner 明确释放自己的原生句柄后，新操作才认领自己的锁并完成安全清理。
  await expect(transaction(store, run)).resolves.toBe("done");
  expect(run).toHaveBeenCalledOnce(); expect(vi.mocked(unlink).mock.calls.filter(call => String(call[0]) === filename)).toHaveLength(0);
  expect(vi.mocked(unlink).mock.calls.filter(call => String(call[0]).startsWith(filename + ".") && String(call[0]).endsWith(".released"))).toHaveLength(1);
  expect(await readdir(root)).toEqual([]);
}, 20000);
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
  // 此 worker 只接触合成临时文件；记录失败阶段和原始堆栈，避免把业务写入与锁释放混为一谈。
  await build({ stdin: { contents: `
    import {Store} from './src/core/storage';
    import {transaction} from './src/cloud/store';
    import {open,unlink} from 'node:fs/promises';
    import path from 'node:path';
    const store=new Store(process.argv[2]);let phase='transaction';let iteration=-1;
    (async()=>{for(let i=0;i<20;i++){iteration=i;phase='transaction';await transaction(store,async()=>{
      const marker=path.join(store.dir,'critical.marker');phase='marker-open';const guard=await open(marker,'wx');
      try{phase='counter-read';const previous=await store.read('counter.json');phase='counter-write';await store.write('counter.json',{count:(previous?.count||0)+1});}
      finally{phase='marker-close';await guard.close();phase='marker-unlink';await unlink(marker);phase='lock-release';}
    });}})().catch(error=>{console.error(JSON.stringify({phase,iteration,code:error.code,syscall:error.syscall,stack:error.stack}));process.exitCode=1});
  `, loader: "ts", resolveDir: process.cwd(), sourcefile: "lock-worker.ts" }, outfile: script, bundle: true, platform: "node", format: "cjs", sourcemap: "inline", alias: { "@": path.resolve("src") }, logLevel: "silent" });
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--enable-source-maps", script, root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child); let error = ""; child.stderr.on("data", bytes => { error += bytes.toString(); }); child.once("error", reject); child.once("exit", code => { children.delete(child); if (code) reject(new Error("Lock worker failed: " + error)); else resolve(); });
  })));
  expect(await new Store(root).read("counter.json")).toEqual({ count: 120 }); await expect(lstat(path.join(root, "critical.marker"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(root)).filter(name => name.endsWith(".lock") || name.endsWith(".released"))).toEqual([]);
}, 20000);
