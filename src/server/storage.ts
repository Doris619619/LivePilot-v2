/** 本机原子状态存储、互斥锁与授权加密；锁名称只由服务端代码指定。 */
import "server-only";
import { mkdir, readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";
import { AppError } from "./errors";
export class Store {
  /** 保存实例目录；业务调用只传服务端固定文件名。 */
  constructor(readonly dir: string) {}
  /** 读取 JSON 状态；缺文件表示首次使用，损坏文件不能当作空状态。 */
  async read<T>(name: string): Promise<T | null> {
    try { return JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as T; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new AppError("STORAGE", "本机状态文件无法读取。请保留 .data 并检查文件权限；不要直接删除直播状态。"); }
  }
  /** 同目录临时文件原子替换，避免中断后留下部分 JSON。 */
  async write(name: string, value: unknown) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const destination = path.join(this.dir, name);
    const temp = destination + "." + randomBytes(8).toString("hex") + ".tmp";
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, destination);
  }
  /** 删除指定内部文件，忽略已不存在的文件。 */
  async remove(name: string) { await unlink(path.join(this.dir, name)).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  // A process lock also protects against accidentally running dev and production together.
  /** 独占指定操作锁并记录 PID；异常退出后需人工核对并恢复锁。 */
  async exclusive<T>(fn: () => Promise<T>, lockName = "control.lock"): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const filename = path.join(this.dir, lockName);
    let handle;
    try { handle = await open(filename, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      throw new AppError("BUSY", "另一个控制操作正在执行，或上次进程异常退出留下 " + lockName + "。请先确认旧服务已停止，再按 README 恢复。", 409);
    }
    try { await handle.writeFile(String(process.pid)); return await fn(); }
    finally { await handle.close(); await unlink(filename); }
  }
}
/** 读取共享本机密钥；格式不正确时拒绝加密。 */
function key() {
  const value = config().encryptionKey;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new AppError("CONFIG", "请配置 64 位十六进制 LIVEPILOT_ENCRYPTION_KEY。");
  return Buffer.from(value, "hex");
}
/** 把授权序列化为带随机 IV 和认证标签的密文。 */
export function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
/** 校验并解密本机授权，失败时不暴露底层解密数据。 */
export function unseal<T>(value: string): T {
  try {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8")) as T;
  } catch { throw new AppError("STORAGE", "无法解密本机授权。请恢复原加密密钥，或在结束现有直播后重新连接 YouTube。"); }
}
/** 保留旧主实例存储入口，兼容单实例数据。 */
export const store = () => new Store(config().dataDir);
