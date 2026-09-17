/** 隔离生产服务的浏览器验收：生成测试账号和素材，不读取真实授权、不启动 OBS。 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes, scryptSync, createHash, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { request as upstreamRequest } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.LIVEPILOT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.LIVEPILOT_PLAYWRIGHT_MODULE).href : "playwright");
const root = await mkdtemp(path.join(os.tmpdir(), "livepilot-remote-smoke-"));
const port = 3398; const origin = "https://127.0.0.1:3399";
const screenshotDir = path.resolve("docs/screenshots/remote-console");
const password = randomBytes(24).toString("hex"); const salt = randomBytes(16).toString("hex");
const access = path.join(root, "access"); const media = path.join(root, "media");
await mkdir(access); await mkdir(path.join(media, "videos"), { recursive: true }); await mkdir(path.join(media, "music"));
await mkdir(screenshotDir, { recursive: true });
await writeFile(path.join(access, "access.json"), JSON.stringify({ users: [{ username: "qa_member", salt, hash: scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex"), revision: "qa", disabled: false }], sessions: {}, attempts: {} }));
const fixture = Buffer.alloc(9 * 1024 * 1024, 3);
await writeFile(path.join(root, "demo.mp4"), fixture); await writeFile(path.join(media, "music", "音乐.mp3"), "test fixture, not playable media");
const env = { ...process.env, LIVEPILOT_ORIGIN: origin, LIVEPILOT_DATA_ROOT: path.join(root, "data"), LIVEPILOT_ACCESS_DIR: access,
  LIVEPILOT_INSTANCES: "main,qa_second", LIVEPILOT_MEDIA_ROOT: media, LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", LIVEPILOT_OBS_EXE: "", LIVEPILOT_OBS_WS_PASSWORD: "", LIVEPILOT_OBS_WS_URL: "ws://127.0.0.1:4455",
  LIVEPILOT_INSTANCE_MAIN_OBS_EXE: "", LIVEPILOT_INSTANCE_MAIN_OBS_WS_PASSWORD: "", LIVEPILOT_INSTANCE_MAIN_OBS_WS_URL: "ws://127.0.0.1:4455", LIVEPILOT_INSTANCE_MAIN_MEDIA_ROOT: media,
  LIVEPILOT_INSTANCE_MAIN_NAME: "日本直播电脑 · 主 OBS", LIVEPILOT_INSTANCE_QA_SECOND_NAME: "日本直播电脑 · 第二 OBS",
  LIVEPILOT_INSTANCE_QA_SECOND_OBS_EXE: "", LIVEPILOT_INSTANCE_QA_SECOND_OBS_WS_URL: "ws://127.0.0.1:4466", LIVEPILOT_INSTANCE_QA_SECOND_OBS_WS_PASSWORD: "", LIVEPILOT_INSTANCE_QA_SECOND_MEDIA_ROOT: media };
// 临时自签名证书仅用于隔离验收，不安装进系统信任库。
await writeFile(path.join(root, "openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n");
execFileSync(process.env.LIVEPILOT_OPENSSL || "openssl", ["req", "-config", path.join(root, "openssl.cnf"), "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { windowsHide: true, stdio: "ignore" });
/** 代理只连接本机服务，保留明确的公网 Host；不缓存或缓冲上传。 */
const proxy = createServer({ key: await readFile(path.join(root, "key.pem")), cert: await readFile(path.join(root, "cert.pem")) }, (request, response) => {
  const upstream = upstreamRequest({ hostname: "127.0.0.1", port, path: request.url, method: request.method, headers: request.headers }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
  upstream.on("error", () => { response.writeHead(502); response.end(); });
  request.on("aborted", () => upstream.destroy()); request.pipe(upstream);
});
await new Promise(resolve => proxy.listen(3399, "127.0.0.1", resolve));
let logs = "";
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
let browser;
/** 只在条件检查之间等待，不模拟业务进度。 */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 60; i++) { if (child.exitCode !== null) throw new Error("Isolated server failed: " + logs); try { if ((await fetch("http://127.0.0.1:" + port)).ok) break; } catch {} await pause(500); }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1050 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin); await page.getByRole("heading", { name: "登录工作台" }).waitFor();
  await page.screenshot({ path: path.join(screenshotDir, "login-desktop.png"), fullPage: true });
  assert.equal((await context.request.get(origin + "/api/instances")).status(), 401);
  await page.getByLabel("账号", { exact: true }).fill("qa_member"); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "直播工作台", exact: true }).waitFor();
  assert.equal((await context.cookies()).find(c => c.name === "livepilot_session").secure, true);
  await page.locator(".instance-panel").nth(1).waitFor();
  assert.equal(await page.locator(".instance-panel").count(), 2);
  await page.locator(".upload-panel summary").click(); await page.locator("#upload-file").setInputFiles(path.join(root, "demo.mp4"));
  let interrupt = true;
  await page.route("**/api/uploads/*", async route => {
    if (interrupt && route.request().method() === "PUT" && Number(route.request().headers()["upload-offset"]) > 0) await route.abort();
    else await route.continue();
  });
  await page.getByRole("button", { name: "上传到直播电脑", exact: true }).click();
  await page.waitForFunction(() => { const value = JSON.parse(localStorage.getItem("livepilot-upload") || "null"); return value?.received === 8 * 1024 * 1024; }, undefined, { timeout: 60000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(b => b.textContent === "继续上传" && !b.disabled), undefined, { timeout: 30000 });
  interrupt = false; await page.reload();
  await page.getByRole("heading", { name: "直播工作台", exact: true }).waitFor();
  await page.locator(".upload-panel summary").click(); await page.locator("#upload-file").setInputFiles(path.join(root, "demo.mp4"));
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await page.getByText(/已加入素材库：/).waitFor({ timeout: 60000 });
  const complete = await page.evaluate(() => JSON.parse(localStorage.getItem("livepilot-upload")));
  assert.equal(complete.received, fixture.length); assert.equal(complete.status, "complete");
  await page.waitForFunction(name => document.querySelector("#video-main")?.textContent.includes(name), complete.publishedName);
  const saved = await readFile(path.join(media, "videos", complete.publishedName));
  assert.equal(createHash("sha256").update(saved).digest("hex"), createHash("sha256").update(fixture).digest("hex"));
  await page.screenshot({ path: path.join(screenshotDir, "console-desktop.png"), fullPage: true });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(screenshotDir, "console-" + width + ".png"), fullPage: true });
  }
  const headers = { origin, "x-livepilot": "1" };
  const requestId = randomUUID();
  const accepted = await context.request.post(origin + "/api/control", { headers, data: { requestId, instanceId: "main", action: "launch" } });
  assert.equal(accepted.status(), 202);
  await page.close(); // 已受理命令不再依赖原浏览器页面。
  let operation;
  for (let i = 0; i < 50; i++) {
    const response = await context.request.get(origin + "/api/status?instanceId=main"); operation = (await response.json()).operation;
    if (operation?.status === "failed") break; await pause(200);
  }
  assert.equal(operation.id, requestId); assert.equal(operation.status, "failed"); // 空 OBS 路径：预期安全失败，无外部副作用。
  const duplicate = await context.request.post(origin + "/api/control", { headers, data: { requestId, instanceId: "main", action: "launch" } });
  assert.equal((await duplicate.json()).operation.id, requestId);
  const evil = await context.request.post(origin + "/api/control", { headers: { ...headers, origin: "https://evil.test" }, data: { requestId: randomUUID(), instanceId: "main", action: "stop" } });
  assert.equal(evil.status(), 403);
  await context.request.delete(origin + "/api/session", { headers });
  assert.equal((await context.request.get(origin + "/api/status?instanceId=main")).status(), 401);
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: HTTPS reverse proxy + Secure cookies, login, two panels, interrupted 9 MiB upload + reload/resume + checksum, 390/768/1440px, async command after page close, dedup, CSRF, logout. No real OBS or YouTube calls.");
} finally {
  await browser?.close();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(5000)]);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("livepilot-remote-smoke-")) throw new Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
}
