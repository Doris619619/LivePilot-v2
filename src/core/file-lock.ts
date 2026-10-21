/** 文件锁释放与 Windows 兼容证据：先移走自己的锁名，旧版本删除挂起只凭原句柄短重试。 */
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AppError } from "./errors";
type Identity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
export type LockObservation = Identity & { handle: FileHandle };
type Pending = Identity & { expires: number };
const shared = globalThis as typeof globalThis & { livePilotLocalLocks?: Set<string>; livePilotPendingLocks?: Map<string, Pending> };
const local = shared.livePilotLocalLocks ??= new Set<string>();
const pending = shared.livePilotPendingLocks ??= new Map<string, Pending>();
const PENDING_WINDOW_MS = 200;
/** 同路径的进程内调用共享闸门，跨进程互斥仍由 wx 原子创建保证。 */
export function lockIdentity(filename: string) { const absolute = path.resolve(filename); return process.platform === "win32" ? absolute.toLowerCase() : absolute; }
/** 在任何异步文件操作前认领本进程的创建尝试；不排队，保持直接控制立即 BUSY。 */
export function claimLocalLock(filename: string): boolean { const key = lockIdentity(filename); if (local.has(key)) return false; local.add(key); return true; }
/** 只有原操作完成创建失败或完成自身锁释放后才放行本进程下一次尝试。 */
export function releaseLocalLock(filename: string) { local.delete(lockIdentity(filename)); }
/** 元数据一致性不使用路径存在与否猜测归属，拒绝链接替换和不同文件 ID。 */
function sameIdentity(left: Identity, right: Identity) { return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs; }
/** Windows 保持自己的句柄，将已完成临界区的锁原子移出公共锁名，再关闭并删除随机释放名；失败保留原错和文件。 */
export async function releaseOwnedLock(filename: string, handle: FileHandle): Promise<void> {
  let released: string | undefined;
  try {
    if (process.platform === "win32") {
      const held = await handle.stat({ bigint: true }), named = await lstat(filename, { bigint: true });
      if (!held.isFile() || held.nlink < 1n || !named.isFile() || named.isSymbolicLink() || !sameIdentity(held, named)) throw new AppError("STORAGE", "锁文件归属已变化，请保留本机状态并核对旧进程。");
      const destination = filename + "." + randomBytes(16).toString("hex") + ".released";
      await rename(filename, destination); released = destination;
    } else released = filename;
  } finally { await handle.close(); }
  // 被观察者仍打开时，Windows 只会让随机释放名删除挂起，公共锁名已可供下一位 owner 原子创建。
  if (released) await unlink(released);
}
/** 只观察普通、可读、小尺寸合法活进程 PID 锁；失败仅放弃证据，实际 wx 错误仍原样返回。 */
export async function observeLock(filename: string): Promise<LockObservation | undefined> {
  let handle: FileHandle | undefined; let retained = false;
  try {
    const before = await lstat(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 10n) return;
    handle = await open(filename, "r"); const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink < 1n || !sameIdentity(before, opened)) return;
    const bytes = Buffer.alloc(11); const read = await handle.read(bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, read.bytesRead).toString("ascii");
    if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 0xffffffff) return;
    process.kill(Number(value), 0);
    const after = await lstat(filename, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after) || before.size !== BigInt(read.bytesRead) || after.size !== before.size || after.mtimeNs !== before.mtimeNs) return;
    retained = true; return { handle, dev: opened.dev, ino: opened.ino, birthtimeNs: opened.birthtimeNs };
  } catch { return undefined; }
  finally { if (!retained) await handle?.close(); }
}
/** Windows 的目录 stat 可仍报告 nlink=1；原只读句柄的 nlink=0 才是已删除挂起的确证。 */
export async function confirmedPendingDelete(filename: string, observation?: LockObservation): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const key = lockIdentity(filename); const now = performance.now();
  for (const [name, value] of pending) if (value.expires <= now) pending.delete(name);
  if (observation) {
    const current = await observation.handle.stat({ bigint: true }).catch(() => undefined);
    if (current?.isFile() && sameIdentity(observation, current) && current.nlink === 0n) {
      const named = await lstat(filename, { bigint: true }).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined);
      if (named === undefined) return false;
      if (named && (!named.isFile() || named.isSymbolicLink() || !sameIdentity(current, named))) return false;
      if (pending.size >= 128) pending.delete(pending.keys().next().value!);
      pending.set(key, { dev: current.dev, ino: current.ino, birthtimeNs: current.birthtimeNs, expires: now + PENDING_WINDOW_MS }); return true;
    }
  }
  const previous = pending.get(key); if (!previous) return false;
  // 原句柄关闭后，至多 200ms 内仅同一个已证实挂起的普通文件可沿用证据。
  const current = await lstat(filename, { bigint: true }).catch(() => undefined);
  return !!current?.isFile() && !current.isSymbolicLink() && sameIdentity(previous, current);
}
