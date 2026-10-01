/** 发布专用持久存储：fsync 后原子替换，检查点仍使用现有 AES-GCM 密钥。 */
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../storage";
import { sleep } from "../errors";
export class PublishingStore extends Store {
  /** 在远端副作用前同步文件；Windows 短暂文件占用使用有限重试。 */
  override async write(name: string, value: unknown) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const destination = path.join(this.dir, name); const temporary = destination + "." + randomBytes(8).toString("hex") + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, destination); break; } catch (e) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code || "") || attempt >= 12) throw e; await sleep(50); }
      }
      if (process.platform !== "win32") { const directory = await open(this.dir, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
