/** 从实际 NSIS 安装目录验收打包 UI；不配对、不初始化 OBS、不操作旧数据。 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
const executable = path.join(process.env.LOCALAPPDATA, "Programs", "LiveNest", "LiveNest.exe");
await access(executable); await access(path.join(path.dirname(executable), "resources", "livenest-installed"));
const profile = path.join(process.env.APPDATA, "LiveNest", "settings.json");
if (await access(profile).then(() => true, () => false)) { const digest = createHash("sha256").update(await readFile(profile)).digest("hex"); if (process.env.LIVENEST_TEST_PROFILE_SHA256 !== digest) throw new Error("Installed acceptance requires an unused profile or an explicitly identified test profile; existing data is preserved"); }
if (!process.env.LIVENEST_TEST_PASSWORD) throw new Error("Set LIVENEST_TEST_PASSWORD");
const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const env = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") }; for (const key of Object.keys(env)) if (/^(LIVENEST_|ELECTRON_|NODE_OPTIONS)/.test(key)) delete env[key];
const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port], { env, windowsHide: true, stdio: "ignore" });
let browser;
try {
  const endpoint = "http://127.0.0.1:" + port; const deadline = Date.now() + 30_000;
  while (true) { if (child.exitCode !== null) throw new Error("Installed app exited"); try { if ((await fetch(endpoint + "/json/version")).ok) break; } catch {} if (Date.now() > deadline) throw new Error("Installed UI unavailable"); await new Promise(resolve => setTimeout(resolve, 200)); }
  browser = await chromium.connectOverCDP(endpoint); const context = browser.contexts()[0]; let page;
  for (let i = 0; i < 100; i++) { page = context.pages().find(p => p.url().startsWith("livenest://app/")); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  if (!page) throw new Error("Local UI missing");
  await page.getByRole("heading", { name: "登录 LiveNest" }).waitFor();
  const exposed = await page.evaluate(() => typeof window.require !== "undefined" || typeof window.process !== "undefined"); if (exposed) throw new Error("Node leaked into Renderer");
  await page.getByLabel("账号", { exact: true }).fill("Do"); await page.getByLabel("密码", { exact: true }).fill(process.env.LIVENEST_TEST_PASSWORD); await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "设备配置", exact: true }).waitFor(); const readyDeadline = Date.now() + 30_000;
  while ((await page.evaluate(() => window.liveNest.state())).busy) { if (Date.now() > readyDeadline) throw new Error("Startup checks timed out"); await new Promise(resolve => setTimeout(resolve, 200)); }
  const state = await page.evaluate(() => window.liveNest.state()); if (state.paired || state.agentRunning || state.instances.length) throw new Error("Installed acceptance requires fresh unpaired state");
  if (state.dataRoot.toLowerCase() !== path.join(process.env.LOCALAPPDATA, "LiveNest").toLowerCase()) throw new Error("Unexpected default data directory");
  if (state.checks.length < 7 || state.checks.some(c => c.id !== "cloud" && c.status !== "ready")) throw new Error("Installed resources check failed");
  await page.screenshot({ path: "docs/desktop/screenshots/installed.png", fullPage: true });
  await page.getByRole("button", { name: "退出登录", exact: true }).click(); await page.getByRole("heading", { name: "登录 LiveNest" }).waitFor();
  console.log(JSON.stringify({ result: "passed", executable, version: state.version, systemNodeOnPath: false, checks: state.checks.map(c => ({ id: c.id, status: c.status })) }));
} finally {
  if (browser) await browser.close();
  // 只结束本脚本启动且确认未配对的客户端 PID，不查找或终止其他 OBS/Agent。
  if (child.pid && child.exitCode === null) execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
