/** 生产构建的 Next 整页回归：隔离运行目录与全部合成 API，核对 URL、水合及跨工作区状态。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "playwright/test";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";

const temporary = await mkdtemp(path.join(os.tmpdir(), "livenest-next-guidelines-"));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = "http://127.0.0.1:" + port;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LIVEPILOT_|GOOGLE_|DEEPSEEK_|LIVENEST_)/.test(key)));
Object.assign(env, { LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: origin, LIVEPILOT_DATA_ROOT: temporary, LIVEPILOT_ACCESS_DIR: path.join(temporary, "access"), LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex"), NEXT_TELEMETRY_DISABLED: "1" });
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: process.cwd(), env, windowsHide: true, stdio: "ignore" });
let browser;
const errors = [], checks = [], unknown = [];
/** 等待本次隔离服务就绪，失败最多等待30秒；只访问 loopback 首页。 */
async function ready() {
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) throw new Error("Isolated Next server exited: " + child.exitCode);
    try { if ((await fetch(origin)).ok) return; } catch { /* 首次监听前继续等待。 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Isolated Next server did not start");
}
try {
  await ready();
  browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const fixture = createPublishingPreview(); fixture.view.administrator = true;
  // 此场景验证新向导的跨模块连续性，避免旧 Cloud 草稿自动定位到确认或执行步骤。
  fixture.view.plans = []; fixture.view.jobs = [];
  const instance = { id: "main", name: "合成 OBS", agentId: "preview_liang", agentName: "合成电脑" };
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    let value;
    if (url.pathname === "/api/session") value = { user: { username: "Ureview", role: "admin" } };
    else if (url.pathname === "/api/session/accounts") value = { accounts: [{ username: "Ureview", current: true, role: "admin" }] };
    else if (url.pathname === "/api/instances") value = { instances: [instance], agents: [{ id: instance.agentId, name: instance.agentName, owner: "Ureview", online: true, revoked: false, paired: true, instances: [instance] }] };
    else if (url.pathname === "/api/status") value = { state: { phase: "stopped", stage: "合成待机", updatedAt: new Date().toISOString(), selection: { video: "", music: "", videoAudio: false } }, busy: false, obs: { ready: true, running: true, streaming: false }, youtube: { connected: true, channel: "合成频道", lifecycle: "ready", ingest: "inactive" }, media: { videos: [], music: [] }, configuration: { broadcastDetails: true, liveChat: true, missing: [] }, device: { online: true, agentId: instance.agentId, observedAt: Date.now() } };
    else if (url.pathname === "/api/broadcast-defaults") value = { revision: 0, value: { privacy: "public", madeForKids: false, videoAudio: false } };
    else if (url.pathname === "/api/account-ai") value = { revision: 0, configured: false, managed: false, uses: { copy: true, chat: true } };
    else if (url.pathname === "/api/broadcast-profiles") value = { profiles: [] };
    else if (url.pathname === "/api/publishing-templates") value = { profiles: fixture.view.profiles.map(profile => Object.fromEntries(Object.entries(profile).filter(([key]) => !["agentId", "instanceId", "accountId", "channelId", "playlistIds", "thumbnailFilename"].includes(key)))) };
    else if (url.pathname === "/api/publishing") value = request.method() === "GET" ? fixture.view : fixture.request(request.postDataJSON());
    else if (url.pathname === "/api/uploads") value = [];
    else if (url.pathname === "/api/admin/overview") value = { agents: [], customers: [], instances: [], totals: { live: 0, online: 0, offline: 0, customers: 0, errors: 0, unknown: 0 } };
    else if (url.pathname === "/api/admin/accounts") value = { accounts: [] };
    else { unknown.push(url.pathname); return route.fulfill({ status: 409, json: { error: "未允许的合成整页操作" } }); }
    return route.fulfill({ json: value });
  });
  const page = await context.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /hydration|Minified React error/i.test(message.text())) errors.push(message.text()); });
  await page.goto(origin + "/publishing?customer=Ureview");
  const publishing = page.locator('[data-workspace="publishing"]');
  await page.getByRole("navigation", { name: "发布功能", exact: true }).getByRole("link", { name: "我的发布", exact: true }).click();
  await expect(publishing.getByRole("heading", { name: "我的发布", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "搜索发布历史", exact: true });
  await search.fill("海边");
  await expect.poll(() => new URL(page.url()).searchParams.get("publishing-history-query")).toBe("海边");
  await page.reload(); await expect(search).toHaveValue("海边");
  assert.equal(new URL(page.url()).searchParams.get("customer"), "Ureview"); checks.push("发布历史与搜索可分享、刷新恢复，保留原查询");
  await page.getByRole("navigation", { name: "发布功能", exact: true }).getByRole("link", { name: "发布视频", exact: true }).click();
  await publishing.getByRole("button", { name: "检测素材", exact: true }).click();
  await publishing.getByRole("radio", { name: /十月音乐集/ }).check();
  await publishing.getByRole("button", { name: "下一步", exact: true }).click();
  const date = publishing.getByLabel("开始日期", { exact: true }); await date.fill("2030-11-12");
  const primary = page.getByRole("navigation", { name: "工作空间", exact: true });
  await primary.getByRole("link", { name: "直播工作台", exact: true }).click();
  await expect(page.locator('[data-workspace="live"]')).toBeVisible();
  await primary.getByRole("link", { name: "视频发布", exact: true }).click();
  await expect(publishing).toBeVisible();
  await expect(page).toHaveURL(/\/publishing\?/);
  await expect(date).toHaveValue("2030-11-12");
  await page.goBack(); await expect(page.locator('[data-workspace="live"]')).toBeVisible();
  await page.goForward(); await expect(publishing).toBeVisible(); await expect(date).toHaveValue("2030-11-12"); checks.push("Next 跨工作区与前后退保留当前步骤和排期输入");
  await page.goto(origin + "/admin");
  const adminSearch = page.getByRole("searchbox", { name: "查找", exact: true }); await adminSearch.fill("合成电脑");
  await expect.poll(() => new URL(page.url()).searchParams.get("admin-search")).toBe("合成电脑");
  await page.getByRole("tab", { name: "客户账号", exact: true }).click();
  await page.reload(); await expect(page.getByRole("tab", { name: "客户账号", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "设备总览", exact: true }).click(); await expect(adminSearch).toHaveValue("合成电脑"); checks.push("管理员页签与搜索恢复且 Next canonical URL 同步");
  await context.addInitScript(() => Object.defineProperty(window, "navigation", { configurable: true, value: undefined }));
  const fallbackPage = await context.newPage(); let fallbackAccept = true; const fallbackDialogs = [];
  fallbackPage.on("dialog", dialog => { fallbackDialogs.push(dialog.type()); return fallbackAccept ? dialog.accept() : dialog.dismiss(); });
  fallbackPage.on("pageerror", error => errors.push(error.message));
  await fallbackPage.goto(origin + "/workspace?history-step=0");
  await expect(fallbackPage.locator('[data-workspace="live"]')).toBeVisible();
  for (const step of [1, 2, 3]) {
    await fallbackPage.evaluate(value => history.pushState(null, "", "?history-step=" + value), step);
    await expect(fallbackPage).toHaveURL(origin + "/workspace?history-step=" + step);
  }
  await fallbackPage.goBack(); await expect(fallbackPage).toHaveURL(origin + "/workspace?history-step=2");
  await fallbackPage.getByRole("button", { name: "设置", exact: true }).click();
  const fallbackKey = fallbackPage.getByLabel("API Key", { exact: true }); await fallbackKey.fill("synthetic-retained-draft");
  // 表单先 effect 上报 dirty，Provider 再 effect 注册离页保护；等待可观察的草稿状态而非隐藏字段值。
  await fallbackPage.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(fallbackPage.getByRole("button", { name: "继续编辑", exact: true })).toBeVisible();
  await fallbackPage.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect.poll(() => fallbackPage.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  fallbackAccept = false; const beforeFallback = fallbackDialogs.length;
  await fallbackPage.evaluate(() => history.back());
  await expect.poll(() => fallbackDialogs.length).toBe(beforeFallback + 1);
  await expect(fallbackPage).toHaveURL(origin + "/workspace?history-step=2");
  await expect(fallbackKey).toHaveValue("synthetic-retained-draft");
  fallbackAccept = true; await fallbackPage.evaluate(() => history.forward());
  await expect(fallbackPage).toHaveURL(origin + "/workspace?history-step=3");
  await expect(fallbackKey).toHaveValue("synthetic-retained-draft");
  await fallbackPage.getByRole("button", { name: "关闭", exact: true }).click();
  await fallbackPage.getByRole("button", { name: "放弃修改并关闭", exact: true }).click();
  const fallbackPrimary = fallbackPage.getByRole("navigation", { name: "工作空间", exact: true });
  await fallbackPrimary.getByRole("link", { name: "视频发布", exact: true }).click();
  await expect(fallbackPage.locator('[data-workspace="publishing"]')).toBeVisible(); await expect(fallbackPage).toHaveURL(/\/publishing\?/);
  await fallbackPage.goBack(); await expect(fallbackPage.locator('[data-workspace="live"]')).toBeVisible(); await expect(fallbackPage).toHaveURL(origin + "/workspace?history-step=3");
  checks.push("无 Navigation API 的 Next/native 历史取消后保留 forward、密钥草稿与 canonical 路由");
  assert.deepEqual(errors, []); assert.deepEqual(unknown, []);
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors, synthetic: true }, null, 2));
} finally {
  await browser?.close();
  const exit = child.exitCode === null ? new Promise(resolve => child.once("exit", resolve)) : Promise.resolve();
  child.kill(); await exit;
  if (path.dirname(temporary) !== os.tmpdir() || !path.basename(temporary).startsWith("livenest-next-guidelines-")) throw new Error("Unsafe temporary cleanup");
  await rm(temporary, { recursive: true, force: true });
}
