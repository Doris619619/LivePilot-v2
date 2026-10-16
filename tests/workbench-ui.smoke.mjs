/** 工作区连续性验收：合成账号、慢分片上传与本地媒体，禁止真实开播、授权和发布。 */
import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";

const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3022";
const output = path.resolve("docs/screenshots/workbench"); await mkdir(output, { recursive: true });
const publishing = createPublishingPreview(); publishing.view.plans = []; publishing.view.jobs = [];
const instances = [{ id: "main", name: "OBS 1", agentId: "preview_liang", agentName: "演示电脑" }];
let username = "Liang", sessions = 0, creates = 0, completes = 0, releaseChunk;
const heldChunk = new Promise(resolve => { releaseChunk = resolve; });
const offsets = [], failures = [], errors = [], unknown = [];
let upload;
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await context.route("**/api/**", async route => {
  const request = route.request(); const url = new URL(request.url()); const method = request.method();
  let result;
  if (url.pathname === "/api/session") { sessions++; result = { user: { username, role: "customer" } }; }
  else if (url.pathname === "/api/session/accounts") {
    if (method === "POST") { username = request.postDataJSON().username; result = { user: { username, role: "customer" } }; }
    else result = { accounts: [{ username, current: true, role: "customer" }, { username: "Bob", current: false, role: "customer" }] };
  } else if (url.pathname === "/api/instances") result = { instances: username === "Bob" ? [] : instances, agents: username === "Bob" ? [] : [{ id: "preview_liang", name: "演示电脑", owner: username, online: true, revoked: false, paired: true, instances }] };
  else if (url.pathname === "/api/status") result = { state: { phase: "stopped", stage: "待机", updatedAt: new Date().toISOString(), selection: { video: "", music: "", videoAudio: false } }, busy: false, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true, channel: "演示频道", lifecycle: "ready", ingest: "inactive" }, media: { videos: [], music: [] }, configuration: { broadcastDetails: true, liveChat: true, missing: [] }, device: { online: true, agentId: "preview_liang", observedAt: Date.now() } };
  else if (url.pathname === "/api/broadcast-defaults") result = { revision: 0, value: { privacy: "public", madeForKids: false, videoAudio: false } };
  else if (url.pathname === "/api/account-ai") result = { revision: 0, configured: false, managed: false, uses: { copy: true, chat: true } };
  else if (url.pathname === "/api/broadcast-profiles") result = { profiles: [] };
  else if (url.pathname === "/api/publishing-templates") result = { profiles: publishing.view.profiles.map(profile => Object.fromEntries(Object.entries(profile).filter(([key]) => !["agentId", "instanceId", "accountId", "channelId", "playlistIds", "thumbnailFilename"].includes(key)))) };
  else if (url.pathname === "/api/publishing") result = method === "GET" ? publishing.view : publishing.request(request.postDataJSON());
  else if (url.pathname === "/api/uploads" && method === "POST") {
    creates++; const input = request.postDataJSON();
    upload = { ...input, id: input.requestId, received: 0, chunkSize: 8388608, status: "uploading", expiresAt: Date.now() + 3600000 }; result = upload;
  } else if (url.pathname === "/api/uploads") result = [];
  else if (url.pathname.startsWith("/api/uploads/")) {
    if (method === "PUT") {
      const offset = Number(request.headers()["upload-offset"]); offsets.push(offset);
      if (offset === 0) await heldChunk;
      upload.received = Math.min(upload.size, offset + 8388608); result = upload;
    } else if (url.pathname.endsWith("/complete")) { completes++; upload.status = "complete"; result = upload; }
    else result = upload;
  } else { unknown.push(method + " " + url.pathname); return route.fulfill({ status: 409, json: { error: "未允许的合成验收操作" } }); }
  await route.fulfill({ json: result });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
page.on("requestfailed", request => { if (request.method() === "PUT") failures.push(request.failure()?.errorText); });
const live = page.locator('[data-workspace="live"]'); const publish = page.locator('[data-workspace="publishing"]');
/** 顶层导航在两个模块保持位置和名称；窄屏先打开同一导航抽屉。 */
async function switchTo(name) {
  if (page.viewportSize().width <= 760) {
    const trigger = page.getByRole("button", { name: "导航", exact: true }); await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox(); await page.mouse.click(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
    await expect(page.getByRole("dialog", { name: "工作台导航" })).toBeVisible();
  }
  const link = page.getByRole("navigation", { name: "工作空间", exact: true }).getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await link.boundingBox();
  // 顶部导航已经可见，直接模拟鼠标点击；Locator.click 会按 scroll-padding 预先滚动旧页面。
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(name === "直播工作台" ? live : publish).toBeVisible();
}
/** 等待滚动事件落到工作区位置记录，避免用固定延时判断。 */
async function position(y) {
  return page.evaluate(async value => { window.scrollTo({ top: value, behavior: "instant" }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return window.scrollY; }, y);
}
try {
  await page.goto(origin + "/workspace");
  await live.getByRole("tab", { name: "直播编排", exact: true }).click();
  const title = live.getByRole("textbox", { name: "标题 必填", exact: true });
  await title.fill("跨工作区保留的直播草稿");
  await live.getByRole("textbox", { name: "说明", exact: true }).fill("切换后继续编辑这段说明。");
  await live.getByRole("textbox", { name: "文案主题" }).fill("jazz night");
  const titleNode = await title.elementHandle();
  const sidebarNode = await page.getByRole("complementary", { name: "工作台导航" }).elementHandle();
  const liveY = await position(650); assert.ok(liveY > 100);
  const initialSessions = sessions;
  await switchTo("视频发布");
  await expect(publish.getByRole("button", { name: "检测素材", exact: true })).toBeEnabled();
  const publishingTasks = page.getByRole("button", { name: "发布任务", exact: true });
  const publishingSettings = page.getByRole("button", { name: "配置与账号", exact: true });
  await expect(publishingTasks).toHaveAttribute("aria-expanded", "true");
  await expect(publishingSettings).toHaveAttribute("aria-expanded", "true");
  await publishingSettings.press("Enter");
  await expect(publishingSettings).toBeFocused();
  await expect(page.getByRole("navigation", { name: "视频发布设置", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "发布功能" })).toBeVisible();
  await expect(publish.getByRole("button", { name: "检测素材", exact: true })).toBeEnabled();
  assert.equal(await titleNode.evaluate(node => node.isConnected), true);
  assert.equal(await sidebarNode.evaluate(node => node.isConnected), true);
  const accountBounds = await page.getByRole("button", { name: "切换登录账号" }).boundingBox();
  assert.ok(accountBounds.y + accountBounds.height > page.viewportSize().height - 24, "账号始终置底");
  await expect(live.locator("video")).toHaveCount(0);
  assert.equal(sessions, initialSessions, "切换不重新读取会话");
  await publish.getByRole("button", { name: "检测素材", exact: true }).click();
  await publish.getByRole("radio", { name: /十月音乐集/ }).check();
  await publish.getByRole("button", { name: "下一步", exact: true }).click();
  await publish.getByLabel("开始日期", { exact: true }).fill("2030-11-12");
  const publishY = await position(500); assert.ok(publishY > 100);
  await switchTo("直播工作台");
  await expect(live.getByRole("tab", { name: "直播编排", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(liveY, 0);
  await live.getByRole("tab", { name: "直播编排", exact: true }).click();
  await expect(title).toHaveValue("跨工作区保留的直播草稿");
  await expect(live.getByRole("textbox", { name: "说明", exact: true })).toHaveValue("切换后继续编辑这段说明。");
  await expect(live.getByRole("textbox", { name: "文案主题" })).toHaveValue("jazz night");
  await expect(live.locator("video")).toHaveCount(0);
  await switchTo("视频发布");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(publishY, 0);
  await expect(publish.getByLabel("开始日期", { exact: true })).toHaveValue("2030-11-12");
  await page.goBack(); await expect(live).toBeVisible(); await expect(title).toHaveValue("跨工作区保留的直播草稿");
  await page.goForward(); await expect(publish).toBeVisible(); await expect(publish.getByLabel("开始日期", { exact: true })).toHaveValue("2030-11-12");
  await expect(publishingSettings).toHaveAttribute("aria-expanded", "false");
  await publishingSettings.press("Space");
  await expect(publishingSettings).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "视频发布配置包", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "设置", exact: true });
  await settingsDialog.getByRole("button", { name: /^编辑/ }).first().click();
  await settingsDialog.getByLabel("配置名称", { exact: true }).fill("尚未保存的视频发布配置");
  await settingsDialog.getByRole("tab", { name: "AI 服务", exact: true }).click();
  await settingsDialog.getByRole("tab", { name: "发布配置", exact: true }).click();
  await expect(settingsDialog.getByLabel("配置名称", { exact: true })).toHaveValue("尚未保存的视频发布配置");
  await settingsDialog.getByRole("button", { name: "返回", exact: true }).click();
  await settingsDialog.getByRole("button", { name: "放弃修改并返回", exact: true }).click();
  await settingsDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "我的发布", exact: true }).click();
  await switchTo("直播工作台"); await switchTo("视频发布");
  await expect(publish.getByRole("heading", { name: "我的发布", exact: true })).toBeVisible();
  await position(0); await page.screenshot({ path: path.join(output, "publishing-desktop.png") });
  await switchTo("直播工作台");
  await live.getByRole("button", { name: "上传素材", exact: true }).click();
  await live.locator("#upload-file").setInputFiles({ name: "continuity.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(17 * 1024 * 1024, 42) });
  await live.getByRole("button", { name: "开始上传", exact: true }).click();
  await expect.poll(() => offsets.length).toBe(1);
  await switchTo("视频发布");
  await expect(page.getByRole("link", { name: /正在上传.*continuity/ })).toBeVisible();
  releaseChunk();
  await expect(page.getByRole("link", { name: /上传完成.*continuity/ })).toBeVisible({ timeout: 30000 });
  assert.deepEqual(offsets, [0, 8388608, 16777216]); assert.equal(creates, 1); assert.equal(completes, 1); assert.deepEqual(failures, []);
  await page.getByRole("link", { name: /上传完成.*continuity/ }).click();
  await expect(live.getByText("上传完成", { exact: true })).toBeVisible();
  await live.getByRole("button", { name: "收起上传", exact: true }).click();
  await position(0); await page.screenshot({ path: path.join(output, "live-desktop.png") });
  const deviceGroup = page.getByRole("button", { name: "直播设备", exact: true });
  await expect(deviceGroup).toHaveAttribute("aria-expanded", "true");
  await deviceGroup.press("Enter");
  await expect(page.getByRole("navigation", { name: "设备定位", includeHidden: true })).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "添加直播电脑", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileY = await position(350);
  await switchTo("视频发布"); await expect(publish.getByRole("heading", { name: "我的发布", exact: true })).toBeVisible();
  await switchTo("直播工作台"); await expect(title).toHaveValue("跨工作区保留的直播草稿");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(mobileY, 0);
  await expect(page.getByRole("dialog", { name: "工作台导航" })).toHaveCount(0);
  await page.getByRole("button", { name: "导航", exact: true }).click();
  await expect(deviceGroup).toHaveAttribute("aria-expanded", "false");
  await deviceGroup.click();
  await expect(page.getByRole("dialog", { name: "工作台导航" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "设备定位", exact: true })).toBeVisible();
  await deviceGroup.click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导航", exact: true }).click();
  await expect(deviceGroup).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await position(0); await page.screenshot({ path: path.join(output, "live-390.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "切换登录账号" }).click();
  await page.getByRole("button", { name: /Bob.*切换/ }).click();
  await expect(page.getByRole("heading", { name: "连接直播电脑", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "标题 必填" })).toHaveCount(0);
  await expect(publish).toHaveCount(0); assert.ok(sessions >= 2);
  await expect(deviceGroup).toHaveAttribute("aria-expanded", "true");
  assert.deepEqual(errors, []); assert.deepEqual(unknown, []);
  console.log("PASS: default-expanded groups; Enter/Space and hidden-item focus exclusion; independent groups persist across module/viewport/drawer changes and reset on account change; shared navigation/session; live and publishing drafts, editor, steps, scroll and history; 17 MiB upload across switch (one create, three chunks, one complete, zero aborts); media release; mobile navigation; account isolation. Mock API only.");
} finally { releaseChunk(); await browser.close(); }
