/** 按实例恢复已退出进程留下的锁；保留直播状态和加密授权。 */
import { readFile, unlink, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const id = process.argv[2] || "main";
const kind = process.argv[3] || "control";
const ids = (process.env.LIVEPILOT_INSTANCES || "main").split(",").map(value => value.trim());
try {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(id) || !ids.includes(id)) throw new Error("请指定已配置的实例 ID。");
  if (!["control", "tokens", "oauth-bindings", "commands", "access", "uploads", "upload"].includes(kind) || (kind === "oauth-bindings" && id !== "main")) throw new Error("锁类型无效；oauth-bindings 仅位于 main。");
  const data = path.resolve(process.env.LIVEPILOT_DATA_ROOT || ".data");
  let dir = id === "main" ? data : path.join(data, "instances", id);
  if (kind === "commands") dir = path.join(dir, "commands");
  if (kind === "access") dir = path.resolve(process.env.LIVEPILOT_ACCESS_DIR || path.join(data, "access"));
  if (kind === "uploads" || kind === "upload") {
    const configured = process.env["LIVEPILOT_INSTANCE_" + id.toUpperCase() + "_MEDIA_ROOT"] || process.env.LIVEPILOT_MEDIA_ROOT;
    if (!configured || !path.isAbsolute(configured)) throw new Error("媒体根目录未配置。");
    const root = await realpath(configured);
    dir = path.join(root, ".uploads");
    if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) throw new Error("上传目录异常，未删除锁。");
    if (kind === "upload") {
      const uploadId = process.argv[4] || "";
      if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw new Error("请指定上传 ID。");
      dir = path.join(dir, uploadId);
      if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) throw new Error("上传记录目录异常，未删除锁。");
    }
  }
  const lock = path.join(dir, kind + ".lock");
  const pid = Number((await readFile(lock, "utf8")).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("锁中 PID 无效，请人工核对；未删除锁。");
  let alive = true;
  try { process.kill(pid, 0); }
  catch (e) { if (e.code === "ESRCH") alive = false; else throw e; }
  if (alive) throw new Error("锁对应 PID 仍存在。请先确认并停止旧 LivePilot 服务；未删除锁。");
  await unlink(lock);
  console.log(id + " 的 " + kind + " 遗留锁已清除；直播状态与授权文件完整保留。");
} catch (e) {
  if (e.code === "ENOENT") console.log("没有遗留锁。");
  else { console.error(e.message); process.exitCode = 1; }
}
