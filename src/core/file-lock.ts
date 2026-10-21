/** 文件锁进程闸与归属安全释放：Windows 先移走自己的锁名，权限及旧锁错误始终原样保留。 */
import { lstat, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AppError } from "./errors";
type Identity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
const shared = globalThis as typeof globalThis & { livePilotLocalLocks?: Set<string> };
const local = shared.livePilotLocalLocks ??= new Set<string>();
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
  // 即使外部观察句柄仍打开，Windows 只会让随机释放名删除挂起，公共锁名已可供下一位 owner 原子创建。
  if (released) await unlink(released);
}
