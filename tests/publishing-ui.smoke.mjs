/** 在已启动的本地构建上检查发布页面；所有账号、设备和发布 API 在浏览器内模拟。 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const origin = "http://127.0.0.1:3077";
const output = path.resolve(".data/publishing-ui"); await mkdir(output, { recursive: true });
const policy = { enabled: true, publicVerified: false, projectKey: "synthetic", uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: "synthetic@example.invalid", verificationNote: "" };
const assets = [2, 10].map((index, i) => ({ id: String(i + 1).repeat(64), version: String(i + 3).repeat(64), filename: `东京雨夜 ${index}.mp4`, size: 32000000, mtimeMs: 1, sha256: null, hashState: "not_computed" }));
const view = { profiles: [], jobs: [], cleanups: [], policy, administrator: true };
let preview; let confirmed; const errors = []; const actions = [];
const browser = await chromium.launch({ channel: "msedge" });
/** 截图前结束控件焦点并等待滚动布局，避免 sticky 顶栏停留在截图中间。 */
async function capture(page, name) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); const body = route.request().postDataJSON(); let result;
    if (url.pathname === "/api/session") result = { user: { username: "admin", role: "admin" } };
    else if (url.pathname === "/api/instances") result = { instances: [{ id: "main", name: "音乐频道", agentId: "pc", agentName: "工作室电脑" }] };
    else if (url.pathname === "/api/broadcast-assets") result = { playlists: [{ id: "PLsynthetic", title: "Rainy Night Sessions" }] };
    else if (url.pathname === "/api/publishing") {
      if (!body) result = view;
      else {
        actions.push(body.action);
        if (body.action === "consent") { view.consent = { version: body.version }; result = { ok: true }; }
        if (body.action === "assets") result = { assets, thumbnails: [], channelId: "channel_one", channel: "Rainy Night Radio" };
        if (body.action === "profile") { view.profiles = [body.profile]; result = body.profile; }
        if (body.action === "preview") { preview = { id: "11111111-1111-4111-8111-111111111111", profile: view.profiles[0], assets: body.assetIds.map(id => assets.find(a => a.id === id)), slots: [], skipped: [], thumbnails: [], copies: body.assetIds.map(() => ({ title: "Tokyo Night", description: "A quiet evening." })) }; result = preview; }
        if (body.action === "confirm") { confirmed = body; const spec = { id: "22222222-2222-4222-8222-222222222222", batchId: preview.id, owner: "alice", actor: "admin", revision: 1, desired: "run", asset: preview.assets[0], profile: preview.profile, index: 1, policy, overrides: body.overrides?.[0] || {}, consent: { version: "2026-10-01", acceptedAt: Date.now(), ai: false, temporaryPrivateTitle: true } }; view.jobs = [{ spec, createdAt: Date.now(), observed: { id: spec.id, revision: 1, sequence: 1, state: "uploading", offset: 8000000, total: spec.asset.size, updatedAt: Date.now() } }]; result = view.jobs; }
        if (body.action === "job") { const job = view.jobs.find(item => item.spec.id === body.id); job.spec.desired = body.operation === "pause" ? "pause" : body.operation === "resume" ? "run" : "cancel"; job.spec.revision++; if (body.operation !== "cancel") job.observed.revision = job.spec.revision; result = job; }
        if (body.action === "cleanup") { view.jobs = []; view.profiles = []; view.cleanups = [{ id: "cleanup", agentId: "pc", instanceId: "main", deadline: Date.now() + 7 * 86400000, state: "pending" }]; result = view.cleanups[0]; }
      }
    }
    assert.ok(result, "Unexpected mocked request: " + url.pathname); await route.fulfill({ json: result });
  });
  await page.goto(origin + "/publishing"); await page.getByRole("heading", { name: "素材库", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "读取素材", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "同意并继续" }).click(); await page.getByRole("button", { name: "读取素材", exact: true }).click(); await page.getByRole("button", { name: "新建配置" }).first().click();
  await page.getByLabel(/^可见性/).selectOption("private"); await page.getByLabel("是否专为儿童制作").selectOption("false"); await page.getByLabel(/^封面/).selectOption("none");
  await page.getByText("标签与播放列表", { exact: true }).click(); await page.getByRole("button", { name: "读取播放列表", exact: true }).click(); await page.getByLabel("Rainy Night Sessions").check();
  await capture(page, "profile-desktop.png");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "全选", exact: true }).click(); await page.getByRole("button", { name: "东京雨夜 10.mp4 上移" }).click();
  await capture(page, "assets-desktop.png"); await page.getByRole("button", { name: "预览排期", exact: true }).click();
  await page.getByRole("heading", { name: "确认发布", exact: true }).waitFor(); assert.equal(preview.assets[0].filename, "东京雨夜 10.mp4"); assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布" }).isDisabled(), true);
  await capture(page, "confirmation-collapsed.png");
  await page.getByRole("button", { name: "编辑文案" }).first().click(); const title = page.getByLabel("标题覆盖"); await title.fill("🌙".repeat(101));
  await page.getByLabel(/^确认频道、素材和排期/).check(); assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布" }).isDisabled(), true);
  await title.fill("🌙".repeat(100)); assert.equal(Array.from(await title.inputValue()).length, 100); assert.equal(await title.getAttribute("maxlength"), null); assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布" }).isDisabled(), false); await title.fill("东京雨夜 · Tokyo Rainy Night");
  await capture(page, "confirmation-desktop.png"); await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false); await capture(page, "confirmation-mobile.png");
  await page.getByRole("button", { name: "确认上传并按计划发布" }).click(); await page.getByText("上传中", { exact: true }).waitFor(); assert.equal(confirmed.overrides[0].title, "东京雨夜 · Tokyo Rainy Night");
  await capture(page, "queue-mobile.png");
  await page.getByRole("button", { name: "暂停", exact: true }).click(); await page.getByText("暂停待设备确认", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).click(); await page.getByText("上传中", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消任务", exact: true }).click(); await page.getByRole("button", { name: "确认取消", exact: true }).click(); await page.getByText("取消待设备确认", { exact: true }).waitFor();
  const scheduled = structuredClone(view.jobs[0]); scheduled.spec.id = "33333333-3333-4333-8333-333333333333"; scheduled.spec.desired = "run"; scheduled.spec.profile.privacy = "public"; scheduled.spec.profile.scheduled = true; scheduled.spec.originalPublishAt = new Date().toISOString(); scheduled.observed.revision = scheduled.spec.revision; scheduled.observed.state = "scheduled"; scheduled.observed.effectivePublishAt = scheduled.spec.originalPublishAt; view.jobs.push(scheduled);
  await page.getByRole("button", { name: "日历", exact: true }).click(); await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("已定时", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下个月", exact: true }).click(); await page.getByRole("button", { name: "上个月", exact: true }).click(); await page.getByRole("button", { name: "今天", exact: true }).click();
  for (const width of [390, 320, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "calendar-" + width + ".png"); const overflowing = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "absolute" && !element.closest(".publishing-sidebar nav")).map(element => element.className)); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "Overflow at " + width + ": " + overflowing.join(",")); }
  await page.getByRole("button", { name: "授权与数据", exact: true }).click(); await page.getByRole("button", { name: "撤销授权与删除数据", exact: true }).click(); await page.getByRole("button", { name: "确认撤销与删除", exact: true }).click(); await page.getByText(/等待设备清理，期限/).waitFor(); assert.equal(await page.getByText("授权撤销与设备清理已确认", { exact: true }).count(), 0);
  await page.goto(origin + "/privacy"); await page.getByRole("heading", { name: "LiveNest 隐私政策" }).waitFor(); await page.goto(origin + "/terms"); await page.getByRole("heading", { name: "LiveNest 服务条款" }).waitFor();
  assert.deepEqual(errors, []); await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, mockedApi: true, realUploads: false, actions, screenshots: ["assets-desktop.png", "profile-desktop.png", "confirmation-collapsed.png", "confirmation-desktop.png", "confirmation-mobile.png", "queue-mobile.png", "calendar-1440.png", "calendar-390.png", "calendar-320.png", "calendar-1024.png"], viewportWidths: [1440, 1024, 390, 320] }, null, 2)); console.log("Publishing browser smoke passed (mock API; no real upload).");
} finally { await browser.close(); }
