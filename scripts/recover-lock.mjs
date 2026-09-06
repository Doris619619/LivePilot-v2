import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
const lock = path.resolve(".data/control.lock");
try {
  const pid = Number((await readFile(lock, "utf8")).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("锁中 PID 无效，请人工核对；未删除锁。");
  let alive = true;
  try { process.kill(pid, 0); }
  catch (e) { if (e.code === "ESRCH") alive = false; else throw e; }
  if (alive) throw new Error("锁对应 PID 仍存在。请先确认并停止旧 LivePilot 服务；未删除锁。");
  await unlink(lock);
  console.log("已清除旧进程遗留锁；直播状态与授权文件完整保留。");
} catch (e) {
  if (e.code === "ENOENT") console.log("没有遗留锁。");
  else { console.error(e.message); process.exitCode = 1; }
}
