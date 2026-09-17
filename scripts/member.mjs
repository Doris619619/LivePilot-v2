/** 本机成员管理：交互读取密码，不接受命令行明文密码；修改账号时撤销会话。 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomBytes, scrypt as derive } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
import { promisify } from "node:util";
const [action, username] = process.argv.slice(2);
if (!["create", "reset", "disable", "list"].includes(action) || (action !== "list" && !/^[a-z0-9_]{3,32}$/.test(username || ""))) {
  console.error("用法：npm run member -- create|reset|disable <用户名>，或 npm run member -- list"); process.exit(1);
}
const dir = path.resolve(process.env.LIVEPILOT_ACCESS_DIR || path.join(process.env.LIVEPILOT_DATA_ROOT || ".data", "access"));
await mkdir(dir, { recursive: true });
const file = path.join(dir, "access.json");
const lock = path.join(dir, "access.lock");
let handle;
try {
  handle = await open(lock, "wx");
  await handle.writeFile(String(process.pid));
  let state;
  try { state = JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; state = { users: [], sessions: {}, attempts: {} }; }
  if (action === "list") console.log(state.users.map(u => u.username + (u.disabled ? "（已禁用）" : "（启用）")).join("\n") || "尚无成员");
  else {
    let user = state.users.find(u => u.username === username);
    if (action === "create" && user) throw new Error("账号已存在");
    if (action !== "create" && !user) throw new Error("账号不存在");
    if (action === "disable") user.disabled = true;
    else {
      if (!process.stdin.isTTY) throw new Error("请在本机交互式终端运行，以隐藏密码输入。");
      let muted = false;
      const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      /** 隐藏密码回显，结束后恢复正常终端输出。 */
      async function secret(label) { process.stdout.write(label); muted = true; const value = await rl.question(""); muted = false; process.stdout.write("\n"); return value; }
      let password, confirm;
      try { password = await secret("密码（12–256 位）："); confirm = await secret("再次输入："); } finally { rl.close(); }
      if (password.length < 12 || password.length > 256 || password !== confirm) throw new Error("密码长度不符或两次输入不一致");
      const salt = randomBytes(16).toString("hex");
      const hash = (await promisify(derive)(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString("hex");
      if (!user) { user = { username }; state.users.push(user); }
      Object.assign(user, { salt, hash, disabled: false });
    }
    user.revision = randomBytes(16).toString("hex");
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, s]) => s.username !== username));
    const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, file);
    console.log("账号已更新，旧会话已撤销。");
  }
} catch (e) { console.error(e.code === "EEXIST" ? "账号存储正在使用；若服务异常退出，请核对进程后恢复 access.lock。" : e.message); process.exitCode = 1; }
finally { if (handle) { await handle.close(); await unlink(lock); } }
