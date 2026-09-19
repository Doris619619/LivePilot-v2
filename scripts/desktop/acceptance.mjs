/** 真 Electron 与隔离 OBS 验收；不配对生产设备、不授权、不推流。 */
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.LIVENEST_PLAYWRIGHT || "playwright");
const data = await mkdtemp(path.join(tmpdir(), "livenest-acceptance-")); const output = path.resolve("docs/desktop/screenshots"); await mkdir(output, { recursive: true });
const env = { ...process.env, LIVENEST_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.LIVENEST_TEST_PASSWORD;
const launchOptions = { executablePath: require("electron"), args: ["."], cwd: process.cwd(), env, timeout: 30_000 };
let application = await _electron.launch(launchOptions);
const errors = [];
/** Windows 启动外壳会等待它派生的 OBS；关闭仅属于本次临时目录的测试窗口。 */
function closeTestObs() {
  if (path.dirname(data) !== tmpdir() || !path.basename(data).startsWith("livenest-acceptance-")) throw new Error("Unsafe test cleanup path");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$root=[IO.Path]::GetFullPath($env:LN_ACCEPTANCE_OBS); Get-CimInstance Win32_Process -Filter \"Name = 'obs64.exe'\" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $owned=Get-Process -Id $_.ProcessId; [void]$owned.CloseMainWindow(); if (!$owned.WaitForExit(3000)) { $owned.Kill() } }"], { windowsHide: true, env: { ...process.env, LN_ACCEPTANCE_OBS: path.join(data, "data", "obs") }, stdio: "ignore" });
}
/** 验收中没有 Agent 任务；移除托盘拦截，以正常 app.quit 等待资源保存。 */
async function closeTestApplication() {
  closeTestObs();
  await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners("before-quit"); for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners("close"); });
  await application.close();
}
try {
  const page = await application.firstWindow(); page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.getByRole("heading", { name: "登录 LiveNest" }).waitFor();
  await page.screenshot({ path: path.join(output, "login.png"), fullPage: true });
  const blocked = await page.evaluate(async () => { try { await window.liveNest.state(); return false; } catch { return true; } }); if (!blocked) throw new Error("Unauthenticated state exposed");
  if (!process.env.LIVENEST_TEST_PASSWORD) throw new Error("Set LIVENEST_TEST_PASSWORD for local UI acceptance");
  await page.getByLabel("账号", { exact: true }).fill("Do"); await page.getByLabel("密码", { exact: true }).fill("incorrect"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "账号或密码不正确" }).waitFor();
  await page.getByLabel("密码", { exact: true }).fill(process.env.LIVENEST_TEST_PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "设备配置", exact: true }).waitFor();
  const readyDeadline = Date.now() + 30_000;
  while ((await page.evaluate(() => window.liveNest.state())).busy) { if (Date.now() > readyDeadline) throw new Error("Startup checks timed out"); await new Promise(resolve => setTimeout(resolve, 200)); }
  await page.waitForFunction(() => !!window.liveNest); const state = await page.evaluate(() => window.liveNest.state()); if (state.paired || state.instances.length) throw new Error("Test was not isolated");
  await page.screenshot({ path: path.join(output, "setup.png"), fullPage: true });
  await page.getByRole("button", { name: "帮助", exact: true }).click(); await page.getByRole("button", { name: "WebSocket", exact: true }).click();
  await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0)); await page.screenshot({ path: path.join(output, "obs-help.png"), fullPage: true });
  await page.getByRole("button", { name: "设备配置", exact: true }).click();
  if (process.argv.includes("--obs")) {
    await page.evaluate(() => window.liveNest.act("prepare"));
    const initialized = await page.evaluate(() => window.liveNest.state()); if (!initialized.instances[0]?.initialized) throw new Error(initialized.message || "OBS setup incomplete: " + JSON.stringify(initialized));
    await page.evaluate(() => window.liveNest.act("prepare")); const repeated = await page.evaluate(() => window.liveNest.state()); if (repeated.instances.length !== 1) throw new Error("Repeated setup created another OBS");
    if (process.argv.includes("--multi")) { await page.evaluate(() => window.liveNest.act("add")); const multi = await page.evaluate(() => window.liveNest.state()); if (multi.instances.length !== 2 || multi.instances.some(i => !i.initialized) || new Set(multi.instances.map(i => i.port)).size !== 2) throw new Error("Multiple OBS isolation failed"); }
    await page.screenshot({ path: path.join(output, "configured.png"), fullPage: true });
    await writeFile(path.join(data, "obs-path.json"), JSON.stringify({ exe: repeated.instances[0].exe }));
  }
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(800, 750); window.show(); window.focus(); });
  await page.bringToFront(); await page.screenshot({ path: path.join(output, "narrow.png"), fullPage: true, timeout: 60_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); if (overflow) throw new Error("Horizontal overflow");
  const beforeLogout = await page.evaluate(() => window.liveNest.state()); await page.getByRole("button", { name: "退出登录", exact: true }).click(); await page.getByRole("heading", { name: "登录 LiveNest" }).waitFor();
  const denied = await page.evaluate(async () => { try { await window.liveNest.act("check"); return false; } catch { return true; } }); if (!denied) throw new Error("Logout did not revoke IPC access");
  await page.getByLabel("账号", { exact: true }).fill("Do"); await page.getByLabel("密码", { exact: true }).fill(process.env.LIVENEST_TEST_PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click(); await page.getByRole("heading", { name: "设备配置", exact: true }).waitFor();
  const afterLogout = await page.evaluate(() => window.liveNest.state()); if (JSON.stringify(beforeLogout.instances) !== JSON.stringify(afterLogout.instances) || beforeLogout.agentRunning !== afterLogout.agentRunning) throw new Error("Logout changed background configuration");
  await closeTestApplication();
  application = await _electron.launch(launchOptions); const reopened = await application.firstWindow(); await reopened.getByRole("heading", { name: "登录 LiveNest" }).waitFor();
  await reopened.getByLabel("账号", { exact: true }).fill("Do"); await reopened.getByLabel("密码", { exact: true }).fill(process.env.LIVENEST_TEST_PASSWORD); await reopened.getByRole("button", { name: "登录", exact: true }).click(); await reopened.getByRole("heading", { name: "设备配置", exact: true }).waitFor();
  const restored = await reopened.evaluate(() => window.liveNest.state()); if (JSON.stringify(restored.instances) !== JSON.stringify(afterLogout.instances) || restored.dataRoot !== afterLogout.dataRoot) throw new Error("Restart did not preserve configuration");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ result: "passed", isolatedData: data, screenshots: output, obs: process.argv.includes("--obs"), restart: true }));
} finally { await closeTestApplication(); }
