/** 隔离 Next 服务及全模拟 API 验证真实浏览器互动面板；不连接 OBS、YouTube、DeepSeek 或客户设备。 */
import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const output = path.resolve(".data/live-chat-ui"); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, "session-"));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = "http://127.0.0.1:" + port;
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(LIVEPILOT_|GOOGLE_|DEEPSEEK_)/.test(name)) delete env[name];
Object.assign(env, { LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: origin, LIVEPILOT_DATA_ROOT: root, LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex"), GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", DEEPSEEK_API_KEY: "", NEXT_TELEMETRY_DISABLED: "1" });
const log = await open(path.join(root, "web.log"), "a");
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }); await log.close();
let browser;
const requests = [], errors = [];
let offline = false;
const config = { enabled: true, preset: "friendly", customPrompt: "", intervalSeconds: 5 };
let chat = { config, configured: true, state: "running", message: "演示数据：正在与观众互动。", sent: 12, skipped: 3, queued: 1, recent: [{ id: "first", authorId: "guest", author: "观众小梁", text: "今晚的音乐很舒服！", reply: "[AI] @观众小梁 欢迎，祝你度过轻松的夜晚。", status: "sent", at: Date.now() }, { id: "long", authorId: "another", author: "A very long multilingual viewer name 超长观众名字", text: "こんにちは " + "多语言长留言".repeat(30), reply: "[AI] @guest こんにちは！", status: "sent", at: Date.now() }], updatedAt: Date.now() };
const instances = [{ id: "main", name: "演示视频直播", agentId: "synthetic_pc", agentName: "模拟直播电脑" }, { id: "main", name: "旧版实例", agentId: "synthetic_old", agentName: "模拟旧电脑" }];
/** 每次返回当前合成状态，验证直播锁与聊天设置互不影响。 */
function dashboard(legacy = false) {
  return { state: { phase: "live", stage: "演示直播中", startedAt: new Date(Date.now() - 10_000).toISOString(), updatedAt: new Date().toISOString(), selection: { video: "demo.mp4", music: "demo.mp3", videoAudio: false } }, busy: false,
    obs: { ready: true, running: true, streaming: offline ? null : true, durationMs: 10_000 }, youtube: { connected: true, channel: legacy ? "演示旧频道" : "演示 · AI 音乐直播", lifecycle: "live", ingest: "active" }, media: { videos: ["demo.mp4"], music: ["demo.mp3"] },
    configuration: { broadcastDetails: true, ...(!legacy ? { liveChat: true } : {}), missing: [], privacy: "private", madeForKids: false }, ...(!legacy ? { liveChat: structuredClone(chat) } : {}), device: { agentId: legacy ? "synthetic_old" : "synthetic_pc", name: "模拟设备", online: !offline, lastSeen: Date.now(), observedAt: Date.now() } };
}
/** 仅截获合成 API；任何未约定的请求都拒绝，测试不能落到真实业务路由。 */
async function mock(route) {
  const request = route.request(), url = new URL(request.url());
  const user = { username: "synthetic_customer", role: "customer" };
  let result;
  if (url.pathname === "/api/session") result = { user };
  else if (url.pathname === "/api/session/accounts") result = { accounts: [{ ...user, current: true }] };
  else if (url.pathname === "/api/instances") result = { instances, agents: instances.map(i => ({ id: i.agentId, name: i.agentName, owner: user.username, online: true, lastSeen: Date.now(), revoked: false, instances: [{ id: i.id, name: i.name }] })) };
  else if (url.pathname === "/api/status") result = dashboard(url.searchParams.get("agentId") === "synthetic_old");
  else if (url.pathname === "/api/live-chat") {
    const body = request.postDataJSON(); requests.push(body); assert.equal(body.agentId, "synthetic_pc"); assert.equal(body.instanceId, "main");
    assert.ok(["read", "configure"].includes(body.action), "面板只读取状态或保存配置。"); assert.equal("apiKey" in body, false);
    if (body.action === "configure") chat = { ...chat, config: body.config, state: body.config.enabled ? "running" : "disabled", queued: 0, updatedAt: Date.now() };
    result = chat;
  }
  else { await route.fulfill({ status: 409, json: { error: "此测试不执行真实业务操作。" } }); return; }
  await route.fulfill({ json: result });
}
/** 元素截图临时隐藏面板外的悬浮页头和跳转链接，避免长截图混入固定 UI。 */
async function screenshotPanel(panel, filename) {
  await panel.screenshot({ path: path.join(output, filename), style: ".app-header, .skip-link { visibility: hidden !important; }" });
}
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || attempt >= 100) throw new Error("隔离 Next 服务未启动，请检查本次 web.log。");
    try { if ((await fetch(origin)).ok) break; } catch { /* 仅等待此测试拥有的 loopback 服务。 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await context.route("**/api/**", mock);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); const panel = page.locator("#instance-synthetic_pc-main section").filter({ has: page.getByRole("heading", { name: "AI 观众互动" }) });
  const toggle = panel.getByRole("switch"), persona = panel.getByLabel("互动人设");
  await expect(toggle).toBeEnabled();
  await expect(panel.locator('input[type="password"]')).toHaveCount(0); await expect(panel.getByLabel("DeepSeek API Key", { exact: true })).toHaveCount(0); await expect(panel.getByRole("button", { name: "保存 Key", exact: true })).toHaveCount(0);
  await expect(page.locator("#instance-synthetic_pc-main").getByRole("button", { name: "开始直播", exact: true })).toBeDisabled();
  // 从真实开关按 Tab 进入人设下拉，再按 End 选择最后一项，验证浏览器原生键盘行为。
  await toggle.focus(); await toggle.press("Tab"); await expect(persona).toBeFocused(); await persona.press("End"); await expect(persona).toHaveValue("custom");
  assert.equal(await persona.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2 && getComputedStyle(element).outlineStyle !== "none"), true);
  await panel.getByLabel("自定义人设描述").fill("温柔、简短，跟随观众语言。"); await panel.getByLabel("发送间隔（秒）").fill("10");
  const saveConfig = panel.getByRole("button", { name: "保存互动设置" }); await saveConfig.focus(); await saveConfig.press("Enter"); await panel.getByText("互动设置已保存，直播期间立即生效。", { exact: true }).waitFor();
  assert.equal(chat.config.preset, "custom"); assert.equal(chat.config.intervalSeconds, 10);
  await expect(toggle).toBeEnabled(); await toggle.focus(); await toggle.press("Space"); await panel.getByText("AI 互动已关闭，待回复队列已取消。", { exact: true }).waitFor(); assert.equal(chat.config.enabled, false); await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeEnabled(); await toggle.focus(); await toggle.press("Space"); await panel.getByText("AI 互动已开启；条件就绪后自动回复新留言。", { exact: true }).waitFor(); await expect(toggle).toHaveAttribute("aria-checked", "true");
  chat = { ...chat, configured: false, state: "needs_key", message: "请保存 DeepSeek API Key", updatedAt: Date.now() };
  const refreshChat = panel.getByRole("button", { name: "刷新互动状态", exact: true }); await expect(refreshChat).toBeEnabled(); await refreshChat.click(); await expect(panel.getByText("直播电脑的 DeepSeek 环境配置未就绪，请联系管理员", { exact: true })).toBeVisible();
  await expect(panel.getByText("请保存 DeepSeek API Key", { exact: true })).toHaveCount(0); await expect(panel.locator('input[type="password"]')).toHaveCount(0); await expect(panel.getByRole("button", { name: "检查密钥设置", exact: true })).toHaveCount(0);
  chat = { ...chat, configured: true, state: "needs_attention", message: "频道授权失效，请重新连接频道。", updatedAt: Date.now() };
  await expect(refreshChat).toBeEnabled(); await refreshChat.click(); await expect(panel.getByRole("button", { name: "检查频道授权", exact: true })).toBeVisible(); await expect(panel.getByRole("button", { name: "保存 Key", exact: true })).toHaveCount(0);
  chat = { ...chat, state: "running", message: "演示数据：正在与观众互动。", updatedAt: Date.now() };
  await expect(refreshChat).toBeEnabled(); await refreshChat.click(); await expect(panel.getByText("互动中", { exact: true })).toBeVisible();
  const historySummary = panel.getByText("最近 30 条互动", { exact: true }); await historySummary.focus(); await historySummary.press("Enter"); await expect(panel.locator("ol > li")).toHaveCount(2);
  const minimumTouchHeight = await panel.locator("button, summary").evaluateAll(elements => Math.min(...elements.filter(element => element.getClientRects().length > 0).map(element => element.getBoundingClientRect().height)));
  assert.ok(minimumTouchHeight >= 44, "可见按钮和折叠入口需达到 44px 触控高度。"); await screenshotPanel(panel, "desktop-1440.png");
  await expect(page.locator("#instance-synthetic_old-main").getByText("这台直播电脑的 Agent 暂不支持 AI 观众互动，请升级 Agent 后刷新状态。", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); await screenshotPanel(panel, "mobile-390.png");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 320, height: 800 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await screenshotPanel(panel, "mobile-320.png");
  offline = true; await panel.getByRole("button", { name: "刷新互动状态", exact: true }).click(); await panel.getByText("当前状态未知", { exact: true }).waitFor(); await expect(toggle).toBeDisabled();
  const refreshDevice = panel.getByRole("button", { name: "刷新设备状态", exact: true }); await expect(refreshDevice).toBeEnabled(); const beforeRefresh = requests.length;
  await refreshDevice.click(); await expect(refreshDevice).toBeEnabled(); assert.equal(requests.length, beforeRefresh);
  assert.equal(requests.some(request => request.action === "key" || "apiKey" in request), false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, scenarios: ["live independent controls", "keyboard Tab and native persona selection", "visible keyboard focus", "keyboard Enter form submit", "keyboard Space disable and enable", "44px touch targets", "custom persona", "send interval", "environment setup guidance", "no credential inputs or key action", "channel authorization entrance", "legacy upgrade", "offline unknown", "mobile 390 and 320", "no page errors"], minimumTouchHeight, screenshots: ["desktop-1440.png", "mobile-390.png", "mobile-320.png"], note: "All APIs and livestream data are synthetic; no real chat sent. Element screenshots hide the floating header and skip link outside the panel only during capture." }, null, 2));
  console.log("Live chat browser smoke passed: desktop, mobile, live controls, stale state, legacy Agent and environment-only configuration.");
} finally { await browser?.close(); child.kill(); }
