/** 云端持久化基础：单机原子文件及短锁重试，不依赖请求或进程内队列。 */
import path from "node:path";
import { Store, LockBusyError } from "@/core/storage";
import { dataRoot } from "@/core/config";
import { sleep } from "@/core/errors";
/** 所有云端数据使用独立目录，不能覆盖本地直播状态。 */
export function cloudStore() { return new Store(path.join(dataRoot(), "cloud")); }
/** 短元数据事务竞争可重试；超时仍保留原数据和锁，不猜测恢复。 */
export async function transaction<T>(store: Store, fn: () => Promise<T>, name = "metadata.lock"): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return await store.exclusive(fn, name); }
    catch (error) { if (!(error instanceof LockBusyError && error.lockName === name) || Date.now() >= deadline) throw error; await sleep(25); }
  }
}
