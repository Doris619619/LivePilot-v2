/** 隔离生产构建的视觉与交互验收；UI 状态使用明确夹具，不连接 OBS/YouTube。 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.LIVEPILOT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.LIVEPILOT_PLAYWRIGHT_MODULE).href : "playwright");
const builtinPassword = process.env.LIVEPILOT_BUILTIN_TEST_PASSWORD;
if (!builtinPassword) throw new Error("请通过 LIVEPILOT_BUILTIN_TEST_PASSWORD 私下传入内置账号验收密码。");
const root = await mkdtemp(path.join(os.tmpdir(), "livepilot-ui-smoke-"));
const origin = "http://127.0.0.1:3412";
const screenshots = path.resolve(process.env.LIVEPILOT_SCREENSHOTS || ".data/review-ui-clarity/screenshots");
await mkdir(screenshots, { recursive: true });
const env = { ...process.env, LIVEPILOT_ORIGIN: origin, LIVEPILOT_MODE: "cloud", LIVEPILOT_DATA_ROOT: root, LIVEPILOT_ACCESS_DIR: path.join(root, "access") };
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3412"], { cwd: process.cwd(), env, windowsHide: true, stdio: "ignore" });
let browser;
const errors = [];
/** 只在服务启动条件之间短暂等待。 */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 返回可预测的设备清单，明确与真实服务器/账号数据隔离。 */
function inventory() {
  const agents = [{ id: "studio_a", name: "示例电脑 A", online: true, lastSeen: Date.now(), revoked: false }, { id: "studio_b", name: "示例电脑 B", online: true, lastSeen: Date.now(), revoked: false }];
  const instances = [{ id: "main", name: "OBS B", agentId: "studio_a", agentName: "示例电脑 A" }, { id: "music", name: "OBS A", agentId: "studio_a", agentName: "示例电脑 A" }, { id: "main", name: "OBS A", agentId: "studio_b", agentName: "示例电脑 B" }];
  return { instances, agents: agents.map(a => ({ ...a, instances: instances.filter(i => i.agentId === a.id) })) };
}
/** 覆盖就绪与直播状态，所有控制请求均由浏览器拦截。 */
function dashboard(url) {
  const live = url.searchParams.get("instanceId") === "music";
  const second = url.searchParams.get("agentId") === "studio_b";
  const video = second ? "山间晨雾.mp4" : "示例视频.mp4";
  return { state: { phase: live ? "live" : "idle", stage: live ? "直播运行中" : "等待开始", updatedAt: new Date().toISOString(), ...(live ? { broadcastTitle: "深夜电台", selection: { video, music: "晚风.mp3", videoAudio: false } } : {}) }, busy: false, obs: { ready: true, running: true, streaming: live, durationMs: live ? 3723000 : 0 }, youtube: { connected: true, channel: second ? "示例频道三" : live ? "示例频道二" : "示例频道一", ingest: live ? "active" : "inactive", lifecycle: live ? "live" : "ready" }, media: { videos: [video], music: ["晚风.mp3"] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } };
}
/** 截图前回到顶部并结束入场动画，避免把 sticky 栏截在页面中间。 */
async function capture(page, name, fullPage = false) {
  await page.evaluate(async () => { await document.fonts.ready; if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(screenshots, name + ".png"), fullPage, animations: "disabled" });
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (server.exitCode !== null) throw Error("Preview failed"); await pause(500); }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin); await page.getByRole("heading", { name: "LiveNest 控制台", exact: true }).waitFor();
  await capture(page, "login-desktop");
  for (const width of [375, 390, 768]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "login-" + width); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("账号", { exact: true }).fill("Do"); await page.getByLabel("密码", { exact: true }).fill(builtinPassword);
  let mode = "normal";
  let channelMode = "normal";
  const controlRequests = [];
  let timerMode = "normal"; let timerRevision = 100; let timerRequests = 0;
  await page.route("**/api/instances", async route => route.fulfill({ status: mode === "error" ? 503 : 200, contentType: "application/json", body: JSON.stringify(mode === "error" ? { error: "暂时无法获取设备，请重试。" } : mode === "empty" ? { instances: [], agents: [] } : inventory()) }));
  await page.route("**/api/status?**", async route => {
    const url = new URL(route.request().url());
    const data = dashboard(url);
    if (url.searchParams.get("instanceId") === "music") {
      timerRequests++;
      if (timerMode === "error") { await route.abort(); return; }
      if (timerMode !== "normal") {
        data.device = { agentId: "studio_a", name: "示例电脑 A", online: timerMode !== "offline", lastSeen: Date.now(), observedAt: timerRevision };
        if (timerMode === "stopped") { data.obs.streaming = false; data.obs.durationMs = 0; data.youtube.lifecycle = "complete"; data.state.phase = "stopped"; }
        if (timerMode === "restarted") data.obs.durationMs = 2000;
        if (timerMode === "reconnecting") { data.obs.reconnecting = true; data.obs.durationMs = 7000; }
        if (timerMode === "missing") delete data.obs.durationMs;
      }
    }
    data.youtube.channelId = "UC_" + url.searchParams.get("agentId") + "_" + url.searchParams.get("instanceId");
    if (url.searchParams.get("agentId") === "studio_a" && url.searchParams.get("instanceId") === "main") {
      if (channelMode === "renamed") data.youtube.channel = "示例频道一 新频道";
      if (channelMode === "duplicate") data.youtube.channel = "示例频道三";
      if (channelMode === "disconnected") data.youtube = { connected: false };
      if (channelMode === "expired") { data.youtube.connected = false; data.youtube.error = "授权已失效"; }
      if (channelMode === "offline") data.device = { agentId: "studio_a", name: "示例电脑 A", online: false, lastSeen: Date.now() - 120000 };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.route("**/api/control", async route => { controlRequests.push(route.request().postDataJSON()); await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "验收夹具：未执行真实控制操作" }) }); });
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "示例频道一", exact: true }).waitFor();
  await capture(page, "workspace-desktop");
  const first = page.locator(".instance-card").first();
  await first.getByRole("button", { name: "收起详情", exact: true }).press("Enter");
  assert.equal(await first.getByRole("button", { name: "开始直播", exact: true }).count(), 1);
  await first.getByRole("button", { name: "展开详情", exact: true }).press("Enter");
  await first.locator(".card-expanded-drawer").waitFor();
  assert.equal(await first.getByRole("button", { name: "开始直播", exact: true }).count(), 1);
  assert.equal(await first.getByRole("button", { name: "结束直播", exact: true }).count(), 1);
  assert.equal(await first.locator(".instance-diagnostics").getAttribute("open"), null);
  await first.locator(".instance-diagnostics summary").press("Enter");
  await first.getByRole("button", { name: "重新授权", exact: true }).waitFor();
  await first.locator(".instance-diagnostics summary").press("Enter");
  await capture(page, "workspace-expanded");
  assert.deepEqual(await first.locator(".step-number").allTextContents(), ["1", "2", "3", "4"]);
  assert.equal(await first.locator(".compact-channel").innerText(), "示例电脑 A · OBS B · main");
  assert.equal(await first.getByRole("link", { name: "打开已绑定频道" }).getAttribute("href"), "https://www.youtube.com/channel/UC_studio_a_main");
  const cdp = await context.newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const doc = await cdp.send("DOM.getDocument");
  const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".dock-heading h1" });
  const actualFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
  assert.ok(actualFonts.fonts.some(font => font.isCustomFont && font.familyName === "LiveNest Sans SC"));
  console.log("Verified actual Chinese font:", JSON.stringify(actualFonts.fonts));
  await page.getByRole("button", { name: "上传素材", exact: true }).press("Enter");
  assert.equal(await page.getByRole("button", { name: "收起上传" }).getAttribute("aria-expanded"), "true");
  assert.match(await page.locator("#upload-instance").innerText(), /示例频道一 · 示例电脑 A \/ OBS B \(main\)/);
  await capture(page, "workspace-upload");
  for (const [width,height] of [[375,900],[390,900],[768,1024],[1024,768],[1440,1000]]) {
    await page.setViewportSize({ width,height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const steps = await first.locator(".workflow-step h3").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y }; }));
    if (width >= 1024) {
      assert.ok(steps.every(step => Math.abs(step.y - steps[0].y) < 1), "four step headings must share one desktop row");
      assert.ok(steps.every((step, i) => i === 0 || step.x > steps[i - 1].x), "steps must read left to right");
    } else assert.ok(steps.every((step, i) => i === 0 || step.y > steps[i - 1].y), "narrow screens retain numbered reading order");
    if (width <= 390) assert.ok((await first.getByRole("button", { name: "开始直播", exact: true }).first().boundingBox()).height >= 44);
    await capture(page, "workspace-" + width);
    if (width === 1024 || width === 375) await first.screenshot({ path: path.join(screenshots, "instance-" + width + ".png"), animations: "disabled" });
  }
  await page.getByRole("button", { name: "收起上传" }).click();
  await page.setViewportSize({ width: 390, height: 900 }); await capture(page, "workspace-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await first.getByRole("button", { name: "收起详情", exact: true }).click();
  await first.getByRole("button", { name: "开始直播", exact: true }).click();
  await first.getByRole("alert").filter({ hasText: "验收夹具" }).waitFor();
  assert.equal(controlRequests.at(-1).agentId, "studio_a");
  assert.equal(controlRequests.at(-1).instanceId, "main");
  await first.getByRole("button", { name: "展开详情", exact: true }).click();
  await first.locator(".instance-diagnostics summary").click();
  await page.getByRole("button", { name: "上传素材", exact: true }).click();
  for (const [state, title] of [["renamed", "示例频道一 新频道"], ["duplicate", "示例频道三"], ["disconnected", "OBS B"], ["expired", "示例频道一"], ["offline", "示例频道一"], ["normal", "示例频道一"]]) {
    channelMode = state;
    await first.getByRole("button", { name: "刷新状态", exact: true }).click();
    await first.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelector("#upload-instance").options[0].text.startsWith(expected + " ·"), title);
    if (state === "duplicate") {
      const values = await page.locator("#upload-instance option").evaluateAll(options => options.map(o => o.value));
      assert.equal(new Set(values).size, 3);
      await page.locator(".instance-card").nth(2).getByRole("button", { name: "结束直播", exact: true }).click();
      assert.equal(controlRequests.at(-1).agentId, "studio_b");
      assert.equal(controlRequests.at(-1).instanceId, "main");
    }
    if (state === "disconnected") assert.equal(await first.getByRole("link", { name: "打开已绑定频道" }).count(), 0);
    if (state === "expired") await first.getByText("授权异常", { exact: true }).waitFor();
    if (state === "offline") { await first.getByRole("alert").filter({ hasText: "状态已过期" }).waitFor(); assert.equal(await first.getByRole("button", { name: "开始直播", exact: true }).isDisabled(), true); }
  }
  mode = "error"; await page.reload();
  await page.getByRole("button", { name: "重试连接", exact: true }).waitFor();
  assert.equal(await page.getByText("连接你的第一台直播电脑").count(), 0);
  await capture(page, "workspace-error");
  mode = "empty"; await page.getByRole("button", { name: "重试连接", exact: true }).click();
  await page.getByRole("heading", { name: "连接你的第一台直播电脑" }).waitFor();
  await capture(page, "workspace-empty");
  mode = "normal"; await page.getByRole("button", { name: "刷新设备", exact: true }).click();
  await page.getByRole("heading", { name: "示例频道一", exact: true }).waitFor();
  await first.getByRole("button", { name: "收起详情", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await first.getByRole("button", { name: "展开详情", exact: true }).click();
  assert.equal(await first.locator(".card-expanded-drawer").evaluate(e => getComputedStyle(e).animationName), "none");
  // 用受控浏览器时钟验证逐秒显示；HTTP 仍保持原有五秒轮询。
  timerMode = "duplicate";
  await page.clock.install();
  await page.reload();
  const liveCard = page.locator("#instance-studio_a-music");
  const duration = liveCard.locator(".runtime-duration");
  await duration.filter({ hasText: "01:02:03" }).waitFor();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const seconds = text => text.split(":").reduce((total, value) => total * 60 + Number(value), 0);
  const initialSeconds = seconds(await duration.innerText());
  const readsBeforeTick = timerRequests;
  for (let i = 1; i <= 2; i++) {
    await page.clock.runFor(1000);
    assert.equal(seconds(await duration.innerText()), initialSeconds + i);
    assert.equal(await liveCard.locator(".compact-timer").innerText(), await duration.innerText());
  }
  assert.ok(timerRequests - readsBeforeTick <= 1, "per-second updates must not add per-second network reads");
  await page.clock.runFor(5000);
  assert.equal(seconds(await duration.innerText()), initialSeconds + 7, "repeated Agent snapshot must not rewind duration");
  await page.clock.fastForward(20000);
  await duration.filter({ hasText: /^—$/ }).waitFor();
  for (const [nextMode, expected] of [["stopped", "00:00:00"], ["restarted", "00:00:02"], ["reconnecting", "00:00:07"], ["missing", "—"], ["offline", "—"], ["error", "—"]]) {
    timerMode = nextMode; timerRevision++;
    await page.evaluate(() => window.dispatchEvent(new Event("livepilot-media-updated")));
    await duration.filter({ hasText: new RegExp("^" + expected + "$", "u") }).waitFor();
    await page.clock.runFor(2000);
    assert.equal(await duration.innerText(), nextMode === "restarted" ? "00:00:04" : expected);
  }
  await page.clock.resume();
  console.log("Timer smoke passed: one-second ticks, unchanged polling, duplicate snapshot, bounded catch-up, stopped/restarted/reconnecting/missing/offline/error states.");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("heading", { name: "LiveNest 控制台", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("UI smoke passed: real Do session; mocked ready/live/empty/error states; four numbered steps; channel/OBS identity; rename/disconnect/expired/offline/duplicate channels; target routing; keyboard expand/upload; 5 widths; portrait/landscape; error retry; reduced motion; logout. Screenshots use fixture devices, no actual broadcast.");
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
  await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(3000)]);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("livepilot-ui-smoke-")) throw Error("Unsafe cleanup");
  await rm(root, { recursive: true, force: true });
}
