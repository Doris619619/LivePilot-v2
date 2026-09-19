/** 静态桌面页面反馈验收，使用示例状态；不会调用真实 Agent、OBS 或云端。 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = path.resolve("desktop/out");
const output = path.resolve("docs/desktop/screenshots"); await mkdir(output, { recursive: true });
/** 仅托管构建输出，拒绝目录越界，不连接远程服务。 */
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, "." + new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
    if (!filename.startsWith(root + path.sep)) throw new Error("Invalid path");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
    response.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream"); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 880 } }); const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  /** 桥接模拟长操作与失败恢复，不保存或访问真实设备身份。 */
  await page.addInitScript(() => {
    const state = { version: "PR 示例", dataRoot: "C:/LiveNest", paired: false, agentRunning: false, online: false, autoStart: false, busy: false, instances: [{ id: "main", name: "主 OBS", initialized: false, managed: true, port: 4457, exe: "C:/LiveNest/obs/main/bin/64bit/obs64.exe" }], checks: ["Windows x64", "数据目录", "磁盘空间", "内置 Node 与 Agent", "Agent 程序", "内置 OBS", "网页服务"].map((label, id) => ({ id: String(id), label, status: "ready" })), snapshots: [], update: { status: "idle" } };
    let finish; window.feedbackTest = { state, calls: 0, fail() { state.busy = false; state.activity.status = "failed"; state.activity.message = "OBS 连接检查超时。最后检查结果：端口不属于指定 OBS。请查看 OBS 窗口或配置图解，处理后重试。"; state.message = state.activity.message; finish?.(); }, complete() { state.busy = false; state.activity.status = "complete"; state.message = ""; state.instances[0].initialized = true; finish?.(); } };
    window.liveNest = { session: async () => ({ authenticated: true }), logout: async () => {}, login: async () => ({ ok: true }), state: async () => structuredClone(state), act: async action => {
      if (action === "web") return structuredClone(state);
      window.feedbackTest.calls++; state.busy = true; state.message = ""; state.activity = { action, step: 2, status: "running", stage: "主 OBS · 正在启动 OBS 并检查端口 4457（连接检查最多约 60 秒）", startedAt: Date.now() - 65_000 };
      await new Promise(resolve => { finish = resolve; });
      if (state.activity.status === "failed") throw new Error(state.message);
      return structuredClone(state);
    } };
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  const obs = page.locator(".setup-row").filter({ has: page.getByRole("heading", { name: "准备 OBS", exact: true }) });
  await page.getByPlaceholder("粘贴网页生成的配对信息").fill("保留用户尚未提交的内容");
  await page.getByRole("button", { name: "自动准备 OBS", exact: true }).click();
  await obs.getByText(/正在启动 OBS 并检查端口/).waitFor();
  assert.equal(await obs.getByRole("button", { name: "正在准备 OBS…", exact: true }).isDisabled(), true);
  assert.match(await obs.locator(".setup-elapsed").innerText(), /本次操作已用 (6[5-9]|[7-9]\d) 秒/);
  await obs.screenshot({ path: path.join(output, "setup-progress.png") });
  await page.getByRole("button", { name: "本机 OBS", exact: true }).click();
  await page.getByText(/正在启动 OBS 并检查端口/).waitFor();
  await page.getByRole("button", { name: "设备配置", exact: true }).click();
  assert.equal(await page.getByPlaceholder("粘贴网页生成的配对信息").inputValue(), "保留用户尚未提交的内容");
  await page.evaluate(() => window.feedbackTest.fail());
  await obs.getByRole("alert").getByText(/端口不属于指定 OBS/).waitFor();
  assert.equal(await page.locator(".banner.error").count(), 0);
  await obs.screenshot({ path: path.join(output, "setup-error.png") });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByLabel("账号", { exact: true }).fill("示例账号"); await page.getByLabel("密码", { exact: true }).fill("example-only"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await obs.getByRole("alert").getByText(/端口不属于指定 OBS/).waitFor();
  await page.setViewportSize({ width: 800, height: 750 });
  await obs.screenshot({ path: path.join(output, "setup-error-narrow.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await obs.getByRole("button", { name: "重新检查 OBS", exact: true }).click();
  await obs.getByText(/正在启动 OBS 并检查端口/).waitFor(); assert.equal(await obs.getByRole("alert").count(), 0);
  await page.evaluate(() => window.feedbackTest.complete()); await obs.getByText("已完成", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.feedbackTest.calls), 2); assert.deepEqual(errors, []);
  console.log("PASS: progress, elapsed time, duplicate prevention, navigation, preserved input, inline failure, relogin, narrow layout, retry and completion (example data)");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
