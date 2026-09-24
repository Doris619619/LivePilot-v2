/** 一次性角色迁移：先确认有效 U 管理员，保留密码与业务数据，只撤销降权账号会话。 */
import { readFile, open, writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
if (process.env.LIVEPILOT_ENV_FILE) process.loadEnvFile(process.env.LIVEPILOT_ENV_FILE);
const dir = path.resolve(process.env.LIVEPILOT_ACCESS_DIR || path.join(process.env.LIVEPILOT_DATA_ROOT || ".data", "access"));
const lock = path.join(dir, "access.lock"); const handle = await open(lock, "wx", 0o600);
try {
  await handle.writeFile(String(process.pid));
  const file = path.join(dir, "access.json"); const state = JSON.parse(await readFile(file, "utf8"));
  if (!state.users.some(u => !u.disabled && u.role === "admin" && u.username.startsWith("U"))) throw new Error("必须先通过受控初始化流程配置至少一个有效的 U 开头管理员。");
  const changed = state.users.filter(u => !u.username.startsWith("U") && (u.role === "admin" || (!u.role && u.username === "Do")));
  if (changed.length) {
    const names = new Set(changed.map(u => u.username));
    for (const user of changed) { user.role = "customer"; user.revision = randomBytes(16).toString("hex"); }
    state.sessions = Object.fromEntries(Object.entries(state.sessions).filter(([, s]) => !names.has(s.username)));
    (state.accountEvents ||= []).push(...changed.map(u => ({ actor: "deployment", username: u.username, action: "demote-customer", at: Date.now() })));
    const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, file);
  }
  console.log(JSON.stringify({ changed: changed.map(u => u.username), validAdministrators: state.users.filter(u => !u.disabled && u.role === "admin" && u.username.startsWith("U")).map(u => u.username) }));
} finally { await handle.close(); await unlink(lock); }
