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
    assert.ok(["read", "configure", "preview"].includes(body.action), "面板只读取状态或保存配置。"); assert.equal("apiKey" in body, false);
    if (body.action === "configure") chat = { ...chat, config: body.config, state: body.config.enabled ? "running" : "disabled", queued: 0, updatedAt: Date.now() };
    result = body.action === "preview" ? { action: body.input.text.includes("谈何") ? "clarify" : "reply", reply: body.input.text.includes("谈何") ? "@试聊观众 Was that a typo?" : "@试聊观众 good taste.", reason: body.input.text.includes("谈何") ? "ambiguous" : "conversation" } : chat;
  }
  else { await route.fulfill({ status: 409, json: { error: "此测试不执行真实业务操作。" } }); return; }
  await route.fulfill({ json: result });
}
/** 元素截图临时隐藏面板外的悬浮页头和跳转链接，避免长截图混入固定 UI。 */
async function screenshotPanel(panel, filename) {
  await panel.screenshot({ path: path.join(output, filename), style: ".app-header, .skip-link, .sidebar-mobile-trigger { visibility: hidden !important; }" });
}
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || attempt >= 100) throw new Error("Isolated server did not start");
    try { if ((await fetch(origin)).ok) break; } catch { /* Wait for this test's server only. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.route("**/api/**", mock);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const panel = page.locator("#instance-synthetic_pc-main section").filter({ has: page.getByRole("heading", { name: "AI 观众互动", exact: true }) }).first();
  await panel.getByRole("button", { name: "人设与试聊", exact: true }).click();
  const editor = panel.getByRole("region", { name: "互动人设与频率" });
  const persona = editor.getByLabel("互动人设", { exact: true });
  await expect(persona.locator("option")).toHaveCount(9);
  await persona.selectOption("cat"); await expect(editor.getByText("批准再听一会儿 🐾", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "填入「AI 音乐，未命名」", exact: true }).click();
  await editor.getByLabel("什么时候接话").selectOption("natural");
  await editor.getByText("试聊 · 不发送到直播间", { exact: true }).click();
  await editor.getByRole("button", { name: "what is 谈何", exact: true }).click();
  await editor.getByRole("button", { name: "生成试聊回复", exact: true }).click();
  await expect(editor.locator(".chat-preview-turns")).toContainText("@试聊观众 Was that a typo?");
  await editor.getByLabel("模拟观众留言").fill("I like it");
  await editor.getByRole("button", { name: "生成试聊回复", exact: true }).click();
  await expect(editor.locator(".chat-preview-turns")).toContainText("@试聊观众 good taste.");
  assert.equal(requests.filter(r => r.action === "preview")[1].input.history.length, 1);
  await editor.getByRole("button", { name: "保存互动设置", exact: true }).click();
  await expect(editor.getByText("互动设置已保存，直播期间立即生效。", { exact: true })).toBeVisible();
  assert.equal(chat.config.preset, "cat"); assert.equal(chat.config.replyMode, "natural"); assert.ok(chat.config.channelFacts.includes("AI"));
  await screenshotPanel(editor, "conversation-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshotPanel(editor, "conversation-mobile.png");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await persona.focus(); assert.ok(await persona.evaluate(el => getComputedStyle(el).outlineStyle !== "none"));

  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "conversation-result.json"), JSON.stringify({ passed: true, mocked: true, scenarios: ["9 personas", "style example", "facts", "mode", "two-turn preview", "save during live", "desktop", "390px", "keyboard focus", "no page errors"], requests: requests.map(r => r.action) }, null, 2));
  console.log("Conversation browser checks passed; all APIs synthetic.");
} finally { await browser?.close(); child.kill(); }
