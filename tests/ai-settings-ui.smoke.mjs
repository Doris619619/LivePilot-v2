/** 真实浏览器验收设置迁移；仅使用合成会话、设备和 API 响应，不连接客户设备或模型服务。 */
import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const output = path.resolve("docs/screenshots/ux-simplification"); await mkdir(output, { recursive: true });
await mkdir(".data/settings-ui", { recursive: true });
const root = await mkdtemp(path.resolve(".data/settings-ui/session-"));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = "http://127.0.0.1:" + port;
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(LIVEPILOT_|GOOGLE_|DEEPSEEK_)/.test(name)) delete env[name];
Object.assign(env, { LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: origin, LIVEPILOT_DATA_ROOT: root, LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex"), GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", DEEPSEEK_API_KEY: "", NEXT_TELEMETRY_DISABLED: "1" });
const log = await open(path.join(root, "web.log"), "a");
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, windowsHide: true, stdio: ["ignore", log.fd, log.fd] }); await log.close();
let browser;
const errors = [], requests = [];
let failSave = false, failGenerate = false, failStatus = false, failInventory = false, emptyInventory = false, failAccounts = false, missingChat = false, slowStatus, slowSave, slowAccounts;
let broadcastMode = "idle";
const configured = { main: true, second: false };
const instances = [{ id: "main", name: "OBS 1", agentId: "synthetic_pc", agentName: "演示直播电脑" }, { id: "second", name: "OBS 2", agentId: "synthetic_pc", agentName: "演示直播电脑" }, { id: "offline", name: "离线 OBS", agentId: "synthetic_offline", agentName: "离线电脑" }];
let chat = { config: { enabled: false, preset: "friendly", customPrompt: "", intervalSeconds: 5 }, configured: true, state: "disabled", recent: [], sent: 0, skipped: 0, queued: 0, updatedAt: Date.now() };
/** 提供无推流、无授权副作用的业务快照。 */
function dashboard(id) {
  return { state: { phase: broadcastMode === "live" ? "live" : broadcastMode === "pending" ? "error" : "stopped", ...(broadcastMode === "pending" ? { broadcastTitle: "待核对场次" } : {}), stage: "待机", updatedAt: new Date().toISOString(), selection: { video: "", music: "", videoAudio: false } }, busy: false,
    obs: { ready: true, running: true, streaming: broadcastMode === "live" }, youtube: { connected: true, lifecycle: broadcastMode === "live" ? "live" : "ready", ingest: broadcastMode === "live" ? "active" : "inactive", channel: "演示频道 " + id }, media: { videos: [], music: [] },
    configuration: { broadcastDetails: true, liveChat: true, missing: [], privacy: "private", madeForKids: false }, liveChat: missingChat ? undefined : structuredClone(chat),
    device: { agentId: "synthetic_pc", online: true, lastSeen: Date.now(), observedAt: Date.now() } };
}
/** 未声明的业务接口一律拒绝；写入只改变测试内存。 */
async function mock(route) {
  const url = new URL(route.request().url());
  const user = { username: "Demo", role: "admin" };
  let result;
  if (url.pathname === "/api/session") result = { user };
  else if (url.pathname === "/api/session/accounts") {
    if (slowAccounts) await slowAccounts;
    if (failAccounts) return route.fulfill({ status: 503, json: { error: "模拟账号读取失败" } });
    result = { accounts: [{ ...user, current: true }] };
  }
  else if (url.pathname === "/api/instances") {
    if (failInventory) return route.fulfill({ status: 503, json: { error: "模拟目录失败" } });
    if (emptyInventory) return route.fulfill({ json: { instances: [], agents: [] } });
    result = { instances, agents: ["synthetic_pc", "synthetic_offline"].map(id => ({ id, name: id === "synthetic_pc" ? "演示直播电脑" : "离线电脑", owner: user.username, online: id !== "synthetic_offline", revoked: false, lastSeen: Date.now(), instances: instances.filter(i => i.agentId === id) })) };
  } else if (url.pathname === "/api/status") result = dashboard(url.searchParams.get("instanceId"));
  else if (url.pathname === "/api/broadcast-assets") {
    const body = route.request().postDataJSON(); requests.push(body); assert.equal(body.agentId, "synthetic_pc");
    if (body.action === "ai-status") {
      if (slowStatus && body.instanceId === "main") await slowStatus;
      if (failStatus) return route.fulfill({ status: 503, json: { error: "模拟读取失败" } });
      result = { configured: configured[body.instanceId] };
    } else if (body.action === "ai-key") {
      if (slowSave) await slowSave;
      if (failSave) return route.fulfill({ status: 503, json: { error: "模拟保存失败" } });
      configured[body.instanceId] = true; result = { configured: true };
    } else if (body.action === "ai-generate") {
      if (failGenerate) return route.fulfill({ status: 502, json: { error: "模拟生成失败，原文案已保留。" } });
      result = { demo: true, title: "Quiet Night | Lofi for Study", description: "Warm beats for a peaceful evening. #lofi" };
    } else return route.fulfill({ status: 409, json: { error: "未允许的测试操作" } });
  } else if (url.pathname === "/api/live-chat") {
    const body = route.request().postDataJSON(); requests.push(body);
    assert.equal(body.agentId, "synthetic_pc"); assert.equal(body.instanceId, "main");
    if (body.action === "configure") chat = { ...chat, config: body.config, updatedAt: Date.now() };
    result = chat;
  } else if (url.pathname === "/api/admin/overview") result = { agents: [], customers: [], instances: [], totals: { live: 0, online: 0, offline: 0, customers: 0, errors: 0, unknown: 0 } };
  else return route.fulfill({ status: 409, json: { error: "此验收不执行业务操作" } });
  return route.fulfill({ json: result });
}
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || attempt >= 100) throw new Error("隔离服务未启动");
    try { if ((await fetch(origin + "/workspace")).ok) break; } catch { /* 等待自己的 loopback 服务。 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.route("**/api/**", mock);
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin + "/workspace");
  const first = page.locator("#instance-synthetic_pc-main");
  const title = first.locator('[id^="broadcast-title-"]');
  await expect(title).toBeVisible();
  // 码点与 UTF-8 字节限制保持原算法；计数在字段右下方，超限仍可修正并被标记。
  const titleCount = first.locator('[id^="title-hint-"]'), description = first.locator('[id^="broadcast-description-"]');
  await title.fill("雨".repeat(89) + "🌙"); await expect(titleCount).toContainText("90/100"); await expect(titleCount).toHaveClass(/is-warning/);
  await title.fill("🌙".repeat(101)); await expect(title).toHaveAttribute("aria-invalid", "true"); await expect(titleCount).toContainText("超出 1 字符");
  await description.fill("雨".repeat(1667)); await expect(description).toHaveAttribute("aria-invalid", "true"); await expect(first.locator('[id^="description-hint-"]')).toContainText("超出 1 字节");
  await title.fill("保留我的草稿"); await description.fill(""); await expect(title).toHaveAttribute("aria-invalid", "false");
  const inputRect = await title.boundingBox(), counterRect = await titleCount.boundingBox();
  assert.ok(counterRect.y >= inputRect.y + inputRect.height && Math.abs(counterRect.x + counterRect.width - inputRect.x - inputRect.width) < 2, "计数位于输入框下方并与右侧对齐");
  assert.equal(await titleCount.evaluate(element => getComputedStyle(element).textAlign), "right");
  const records = first.getByRole("button", { name: "活动记录", exact: true });
  await expect(records).toHaveAttribute("aria-expanded", "false"); await records.focus(); await records.press("Enter");
  await expect(records).toHaveAttribute("aria-expanded", "true"); await records.press("Space"); await expect(records).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByRole("button", { name: "结束直播", exact: true })).toHaveCount(0);
  broadcastMode = "live"; await page.reload();
  await first.getByRole("button", { name: "查看运行状态", exact: true }).click();
  await expect(first.getByRole("button", { name: "结束直播", exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "开始直播", exact: true })).toHaveCount(0);
  broadcastMode = "pending"; await page.reload();
  await first.getByRole("button", { name: "查看运行状态", exact: true }).click();
  await expect(first.getByRole("button", { name: "结束直播", exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "重试开播", exact: true })).toBeVisible();
  broadcastMode = "idle"; missingChat = true; await page.reload();
  await expect(first.getByRole("switch")).toBeDisabled();
  await expect(first.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(first.getByRole("switch")).toContainText("待读取");
  missingChat = false; await page.reload();
  await title.fill("保留我的草稿");
  await page.setViewportSize({ width: 1280, height: 820 });
  await title.fill("Late Night Lofi · Study & Relax");
  await title.press("Tab");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, "workspace-desktop.png") });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await title.fill("保留我的草稿");
  await expect(first.getByRole("button", { name: "生成英文文案", exact: true })).toBeVisible();
  await expect(first.locator('input[type="password"]')).toHaveCount(0);
  const openSettings = first.getByRole("button", { name: "API 设置", exact: true });
  await openSettings.click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const target = dialog.getByLabel("配置对象");
  await expect(target).toHaveValue("synthetic_pc:main");
  await expect(dialog.getByText("已配置", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  /** 普通配置不应强迫滚动；同时检查底部操作确实在可见视口内。 */
  async function captureSettings(name) {
    const metrics = await dialog.evaluate(element => ({ height: element.getBoundingClientRect().height, scroll: element.scrollHeight - element.clientHeight, overflow: element.scrollWidth - element.clientWidth }));
    assert.ok(metrics.scroll <= 2 && metrics.overflow <= 2, `${name}: ${JSON.stringify(metrics)}`);
    await dialog.screenshot({ path: path.join(output, name + ".png") });
    console.log(name + ": " + JSON.stringify(metrics));
  }
  await captureSettings("api-configured-desktop");
  await dialog.getByRole("button", { name: "更换 API Key" }).click();
  await captureSettings("api-edit-desktop");
  const key = dialog.getByLabel("新的 API Key", { exact: true });
  await key.fill("sk-synthetic-settings-only");
  failSave = true;
  await dialog.getByRole("button", { name: "保存 API Key", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("保存结果未确认");
  await expect(key).toHaveValue("sk-synthetic-settings-only");
  await captureSettings("api-save-error-desktop");
  failSave = false;
  let finishSave; slowSave = new Promise(resolve => { finishSave = resolve; });
  await dialog.getByRole("button", { name: "保存 API Key", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "保存中…", exact: true })).toBeDisabled();
  await expect(target).toBeDisabled(); await expect(dialog.getByRole("tab", { name: "观众互动" })).toBeDisabled();
  await dialog.press("Escape"); await expect(dialog).toBeVisible();
  finishSave(); slowSave = undefined;
  await expect(dialog.getByText(/API Key 已加密保存/)).toBeVisible();
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  assert.equal(requests.filter(r => r.action === "ai-key").length, 2);
  await target.selectOption("synthetic_pc:second");
  await expect(dialog.getByText("未配置", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await captureSettings("api-unconfigured-desktop");
  await page.screenshot({ path: path.join(output, "settings-context-desktop.png") });
  await target.selectOption("synthetic_offline:offline");
  await expect(dialog.getByText("设备离线", { exact: true })).toBeVisible();
  await captureSettings("api-offline-desktop");
  assert.equal(requests.some(r => r.instanceId === "offline"), false);
  await target.selectOption("synthetic_pc:main");
  await expect(dialog.getByText("已配置", { exact: true })).toBeVisible();
  await dialog.press("Escape"); await expect(openSettings).toBeFocused(); await expect(title).toHaveValue("保留我的草稿");
  failGenerate = true; await first.getByRole("button", { name: "生成英文文案", exact: true }).click();
  await expect(first.getByText("模拟生成失败，原文案已保留。", { exact: true })).toBeVisible(); await expect(title).toHaveValue("保留我的草稿");
  failGenerate = false; await first.getByRole("button", { name: "生成英文文案", exact: true }).click();
  await expect(title).toHaveValue("Quiet Night | Lofi for Study");
  await first.getByRole("button", { name: "撤销填入", exact: true }).click(); await expect(title).toHaveValue("保留我的草稿");
  await first.locator(".broadcast-settings").screenshot({ path: path.join(output, "content-desktop.png"), style: ".app-header,.skip-link {visibility:hidden!important}" });
  await first.getByRole("button", { name: "互动设置", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "观众互动" })).toHaveAttribute("data-state", "active");
  await dialog.getByLabel("互动人设", { exact: true }).selectOption("custom"); await dialog.getByLabel("自定义人设描述").fill("温柔且简短。");
  await dialog.getByLabel("发送间隔（5–60 秒）").fill("10"); await dialog.getByRole("button", { name: "保存互动设置" }).click();
  await expect(dialog.getByText("互动设置已保存，直播期间立即生效。", { exact: true })).toBeVisible();
  assert.equal(chat.config.enabled, false); assert.equal(chat.config.intervalSeconds, 10);
  await captureSettings("chat-preferences-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureSettings("chat-preferences-390");
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.press("Escape");
  await first.getByRole("switch").click(); assert.equal(chat.config.intervalSeconds, 10); assert.equal(chat.config.preset, "custom");
  await openSettings.click(); failStatus = true; await dialog.getByRole("button", { name: "刷新配置状态" }).click();
  await expect(dialog.getByRole("alert")).toContainText("暂时无法读取配置状态"); await expect(dialog.getByText("状态未知", { exact: true })).toBeVisible();
  failStatus = false; await dialog.getByRole("button", { name: "刷新配置状态" }).click(); await expect(dialog.getByRole("alert")).toHaveCount(0);
  // 迟到的旧目标响应不得覆盖新目标；关闭也不能留下密钥输入。
  let release; slowStatus = new Promise(resolve => { release = resolve; });
  await dialog.getByRole("button", { name: "刷新配置状态" }).click();
  await target.selectOption("synthetic_pc:second"); await expect(dialog.getByText("未配置", { exact: true })).toBeVisible();
  release(); slowStatus = undefined;
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await captureSettings(`api-unconfigured-${width}`);
  }
  await dialog.getByLabel("API Key", { exact: true }).fill("sk-synthetic-unsaved-only"); await dialog.press("Escape");
  await openSettings.click(); await expect(dialog.locator('input[type="password"]')).toHaveCount(0); await dialog.press("Escape");
  assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes("sk-synthetic")), false);
  failInventory = true; await openSettings.click(); await expect(dialog.getByRole("alert")).toContainText("无法读取设备列表");
  failInventory = false; await dialog.getByRole("button", { name: "重新读取设备" }).click(); await expect(target).toBeVisible(); await dialog.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(target).toHaveValue(""); await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await dialog.press("Escape");
  emptyInventory = true; await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(dialog.getByText("还没有可配置的实例，请先接入直播电脑。")).toBeVisible(); await expect(target).toBeDisabled();
  await captureSettings("settings-empty-desktop"); await dialog.press("Escape"); emptyInventory = false;
  // 账号加载不能看起来像空列表；失败有就地恢复，恢复不更改当前身份。
  let releaseAccounts; slowAccounts = new Promise(resolve => { releaseAccounts = resolve; });
  failAccounts = true; await page.getByRole("button", { name: "切换登录账号", exact: true }).click();
  await expect(page.getByText("正在读取账号…", { exact: true })).toBeVisible();
  releaseAccounts(); slowAccounts = undefined;
  await expect(page.getByText("无法读取已登录账号，请重试。", { exact: true })).toBeVisible();
  failAccounts = false; await page.getByRole("button", { name: "重试读取账号", exact: true }).click();
  await expect(page.getByRole("button", { name: "Demo 管理员 当前" })).toBeVisible();
  await page.getByRole("dialog", { name: "登录账号" }).press("Escape");
  // 同一配对表单在关闭、移动导航和宽度切换后保留草稿。
  const pairingTrigger = page.getByRole("button", { name: "添加直播电脑", exact: true });
  await pairingTrigger.click();
  const pairingDialog = page.getByRole("dialog", { name: "添加直播电脑", exact: true });
  await pairingDialog.getByLabel("电脑名称").fill("保留电脑名称");
  await pairingDialog.press("Escape"); await expect(pairingTrigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "导航", exact: true }).click(); await pairingTrigger.click();
  await expect(pairingDialog.getByLabel("电脑名称")).toHaveValue("保留电脑名称");
  await pairingDialog.press("Escape"); await expect(pairingTrigger).toBeFocused();
  await page.getByRole("dialog", { name: "工作台导航" }).press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/admin"); await page.getByRole("button", { name: "显示设置", exact: true }).click();
  const display = page.getByRole("dialog", { name: "显示设置", exact: true });
  await display.getByLabel("显示时区").selectOption("Asia/Shanghai"); await display.press("Escape");
  await page.reload(); await page.getByRole("button", { name: "显示设置", exact: true }).click();
  await expect(display.getByLabel("显示时区")).toHaveValue("Asia/Shanghai");
  assert.deepEqual(errors, []);
  console.log("PASS: visible generator; central settings; target isolation; save failure/retry; offline; stale response; draft/undo; chat preference migration; timezone persistence; 320/390/1440 layout; no secrets stored; no real API calls.");
} finally { await browser?.close(); child.kill(); }
