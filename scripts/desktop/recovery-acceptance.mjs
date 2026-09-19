/** 故障恢复界面验收：静态桌面配合合成桥接，不访问真实 Agent、OBS 或账号。 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = path.resolve("desktop/out"); const output = path.resolve(process.env.LIVENEST_TEST_SCREENSHOTS || "docs/desktop/screenshots");
await mkdir(output, { recursive: true });
/** 只托管桌面构建目录，禁止目录越界。 */
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, "." + new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
    if (!filename.startsWith(root + path.sep)) throw new Error("Invalid path");
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
    response.setHeader("Content-Type", mime[path.extname(filename)] || "application/octet-stream"); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 880 } }); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  /** 测试明确区分已登记实例与失败候选；重试承诺保持 pending 直到测试释放。 */
  await page.addInitScript(() => {
    const main = { id: "main", name: "原 OBS", initialized: true, managed: true, port: 4455, exe: "C:/Example/main/obs64.exe" };
    const state = { version: "0.1.1 验收示例", agentId: "pc_fixture", dataRoot: "C:/Example", paired: true, agentRunning: true, online: true, autoStart: false, busy: false, instances: [main], candidates: [{ ...main, id: "candidate", name: "新增 OBS", initialized: false, port: 4456 }], maintenance: false, checks: [], snapshots: [], update: { status: "idle" } };
    let finish; window.recoveryFixture = { state, calls: [], finish: () => finish?.() };
    window.liveNest = { session: async () => ({ authenticated: true }), login: async () => ({ ok: true }), logout: async () => {}, state: async () => structuredClone(state), act: async (action, input) => {
      window.recoveryFixture.calls.push({ action, input });
      if (action === "prepare") { state.busy = true; await new Promise(resolve => { finish = resolve; }); state.busy = false; throw new Error("OBS 连接未确认，待配置内容已保留。"); }
      if (action === "discard") state.candidates = [];
      if (action === "start") { state.online = false; state.message = "网络连接失败，请检查系统代理。"; state.activity = { action, step: 3, status: "failed", stage: "正在连接网页", message: state.message, startedAt: Date.now() }; throw new Error(state.message); }
      return structuredClone(state);
    } };
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByRole("heading", { name: "待配置 OBS" }).waitFor();
  await page.getByRole("button", { name: "重试配置", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "重试配置", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "撤销新增", exact: true }).isDisabled(), true);
  await page.evaluate(() => window.recoveryFixture.finish());
  await page.getByText(/OBS 连接未确认/).waitFor();
  await page.screenshot({ path: path.join(output, "recovery-candidate.png") });
  await page.setViewportSize({ width: 800, height: 750 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "recovery-candidate-narrow.png") });
  await page.getByRole("button", { name: "撤销新增", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "待配置 OBS" }).count(), 0);
  await page.getByRole("button", { name: "本机 OBS", exact: true }).click();
  await page.getByRole("heading", { name: "原 OBS", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "修复连接（先关闭 OBS）", exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.recoveryFixture.calls.map(c => c.action)), ["prepare", "discard"]);
  await page.getByRole("button", { name: "设备配置", exact: true }).click();
  await page.getByText(/无需预装 OBS/).waitFor(); await page.getByText("重新配对", { exact: true }).click();
  await page.getByLabel("恢复配对信息", { exact: true }).fill("LN1.synthetic-recovery");
  await page.getByRole("button", { name: "恢复配对并连接", exact: true }).click();
  assert.equal(await page.getByLabel("恢复配对信息", { exact: true }).inputValue(), "");
  assert.deepEqual(await page.evaluate(() => window.recoveryFixture.calls.at(-1)), { action: "pair", input: { invitation: "LN1.synthetic-recovery" } });
  await page.screenshot({ path: path.join(output, "device-repairing.png") });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "网络连接失败" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重试", exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.recoveryFixture.state.online = true; window.recoveryFixture.state.maintenance = true; });
  await page.getByText("设备维护尚未确认结束，原配置已保留。").waitFor();
  assert.equal(await page.getByRole("alert").filter({ hasText: "网络连接失败" }).count(), 1);
  await page.evaluate(() => { window.recoveryFixture.state.maintenance = false; });
  await page.getByRole("alert").filter({ hasText: "网络连接失败" }).waitFor({ state: "hidden" });
  await page.getByText("本机已连接网页工作台", { exact: true }).waitFor();
  assert.deepEqual(errors, []); console.log("Recovery UI passed: pending, duplicate prevention, retry, archive, old instance, 800px layout and network failure/recovery with maintenance guard (synthetic state).");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
