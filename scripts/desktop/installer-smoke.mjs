/** 仅在全新 Windows CI 用户中实际执行 NSIS 安装、覆盖升级及保留数据卸载；发布前必须通过。 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("Installer smoke requires a disposable GitHub-hosted Windows runner");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const bootstrap = path.join(process.env.APPDATA, "LiveNest");
assert.equal(await access(bootstrap).then(() => true, () => false), false, "Refuse to use an existing LiveNest profile");
const key = "HKCU\\Software\\5ec0ca5f-baf5-5e52-9427-e477a61f08f1";
let registered = false;
try { execFileSync("reg.exe", ["query", key], { stdio: "pipe", windowsHide: true }); registered = true; } catch (error) { if (error.status !== 1) throw error; }
assert.equal(registered, false, "Refuse to replace an existing installation");
const base = await mkdtemp(path.join(os.tmpdir(), "livenest-installer-smoke-"));
const installed = path.join(base, "程序 空格", "LiveNest");
const dataRoot = path.join(base, "数据 空格", "LiveNest");
await mkdir(dataRoot, { recursive: true }); await mkdir(bootstrap);
const locator = JSON.stringify({ version: 1, dataRoot, pending: true });
await writeFile(path.join(bootstrap, "data-location.json"), locator);
await writeFile(path.join(dataRoot, "keep.txt"), "existing user data");
const installer = path.resolve(`release/LiveNest_${version}_x64-setup.exe`);
/** 参数数组保持中文路径与空格完整；退出码非零、超时均阻止发布。 */
function run(executable, args) { execFileSync(executable, args, { windowsHide: true, stdio: "pipe", timeout: 180000 }); }
/** 安装后的程序与实际版本一致，原数据定位和用户文件均保留。 */
async function verify() {
  assert.equal(await readFile(path.join(bootstrap, "data-location.json"), "utf8"), locator);
  assert.equal(await readFile(path.join(dataRoot, "keep.txt"), "utf8"), "existing user data");
  const { extractFile } = await import("@electron/asar");
  assert.equal(JSON.parse(extractFile(path.join(installed, "resources", "app.asar"), "package.json").toString()).version, version);
  await access(path.join(installed, "resources", "livenest-installed"));
}
run(installer, ["/S", "/currentuser", `/D=${installed}`]); await verify();
console.log("NSIS fresh installation passed");
run(installer, ["/S", "/currentuser", "--updated", `/D=${installed}`]); await verify();
console.log("NSIS silent overwrite upgrade passed");
run(path.join(installed, "Uninstall LiveNest.exe"), ["/S", "/currentuser", "/KEEP_APP_DATA", "--updated", `_?=${installed}`]);
assert.equal(await readFile(path.join(bootstrap, "data-location.json"), "utf8"), locator);
assert.equal(await readFile(path.join(dataRoot, "keep.txt"), "utf8"), "existing user data");
console.log("NSIS uninstall preserved user data");
