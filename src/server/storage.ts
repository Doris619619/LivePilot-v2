import "server-only";
import { mkdir, readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";
import { AppError } from "./errors";
export class Store {
  constructor(readonly dir: string) {}
  async read<T>(name: string): Promise<T | null> {
    try { return JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as T; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new AppError("STORAGE", "本机状态文件无法读取。请保留 .data 并检查文件权限；不要直接删除直播状态。"); }
  }
  async write(name: string, value: unknown) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const destination = path.join(this.dir, name);
    const temp = destination + "." + randomBytes(8).toString("hex") + ".tmp";
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, destination);
  }
  async remove(name: string) { await unlink(path.join(this.dir, name)).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  // A process lock also protects against accidentally running dev and production together.
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const filename = path.join(this.dir, "control.lock");
    let handle;
    try { handle = await open(filename, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      throw new AppError("BUSY", "另一个控制操作正在执行，或上次进程异常退出留下 control.lock。请先确认旧服务已停止，再按 README 恢复。", 409);
    }
    try { await handle.writeFile(String(process.pid)); return await fn(); }
    finally { await handle.close(); await unlink(filename); }
  }
}
function key() {
  const value = config().encryptionKey;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new AppError("CONFIG", "请配置 64 位十六进制 LIVEPILOT_ENCRYPTION_KEY。");
  return Buffer.from(value, "hex");
}
export function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function unseal<T>(value: string): T {
  try {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8")) as T;
  } catch { throw new AppError("STORAGE", "无法解密本机授权。请恢复原加密密钥，或在结束现有直播后重新连接 YouTube。"); }
}
export const store = () => new Store(config().dataDir);
