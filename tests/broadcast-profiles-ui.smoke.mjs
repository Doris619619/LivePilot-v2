/** 本地预览浏览器验收：配置 CRUD 使用真实隔离服务端持久化，其余业务为预览合成设备，不开播或授权。 */
import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3021";
const output = path.resolve("docs/screenshots/live-profiles"); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [], writes = [];
let failSave = false;
page.on("pageerror", error => errors.push(error.message));
await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await context.route("**/api/broadcast-profiles", route => {
  if (route.request().method() !== "POST") return route.continue();
  writes.push(route.request().postDataJSON());
  if (failSave) return route.fulfill({ status: 503, json: { error: "模拟保存失败，当前草稿已保留。" } });
  return route.continue();
});
/** 所有测试配置均从 UI 创建；保存使用独立预览目录的真实 API。 */
async function saveAs(panel, name) {
  await panel.getByRole("button", { name: "另存为", exact: true }).click();
  await panel.getByLabel("配置名称", { exact: true }).fill(name);
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(`已保存「${name}」`);
}
try {
  await page.goto(origin + "/workspace");
  const first = page.locator("#instance-preview_liang-main");
  const toolbar = first.getByRole("region", { name: "直播配置", exact: true });
  const picker = toolbar.getByLabel("直播配置", { exact: true });
  const title = first.locator('[id^="broadcast-title-"]');
  await expect(toolbar.getByRole("button", { name: "另存为", exact: true })).toBeEnabled();
  await title.fill("Night Lofi | Study and Rest");
  await first.getByRole("tab", { name: "直播选项", exact: true }).click();
  await first.getByLabel("公开范围", { exact: true }).selectOption("private");
  await saveAs(toolbar, "夜间 Lofi");
  const nightId = await picker.inputValue();
  await first.getByRole("tab", { name: "直播内容", exact: true }).click();
  await title.fill("Morning Piano | A Quiet Start");
  await first.getByRole("tab", { name: "直播选项", exact: true }).click();
  await first.getByLabel("公开范围", { exact: true }).selectOption("unlisted");
  await saveAs(toolbar, "晨间钢琴");
  const morningId = await picker.inputValue();
  await picker.selectOption(nightId);
  await expect(toolbar.getByRole("button", { name: "使用配置", exact: true })).toBeVisible();
  await expect(first.getByLabel("公开范围", { exact: true })).toHaveValue("unlisted");
  await toolbar.getByRole("button", { name: "保留当前草稿", exact: true }).click();
  await expect(picker).toHaveValue(morningId);
  await picker.selectOption(nightId); await toolbar.getByRole("button", { name: "使用配置", exact: true }).click();
  await expect(first.getByLabel("公开范围", { exact: true })).toHaveValue("private");
  await toolbar.getByRole("button", { name: "撤销切换", exact: true }).click();
  await expect(first.getByLabel("公开范围", { exact: true })).toHaveValue("unlisted");
  await picker.selectOption(nightId); await toolbar.getByRole("button", { name: "使用配置", exact: true }).click();
  await first.getByRole("tab", { name: "直播内容", exact: true }).click();
  await title.fill("Late Night Lofi | Study and Rest");
  failSave = true; await toolbar.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(toolbar.getByRole("alert")).toContainText("模拟保存失败");
  await expect(title).toHaveValue("Late Night Lofi | Study and Rest");
  failSave = false; await toolbar.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(toolbar.getByRole("status")).toHaveText("已保存「夜间 Lofi」");
  await toolbar.getByLabel("管理直播配置", { exact: true }).click();
  await toolbar.getByRole("button", { name: "重命名", exact: true }).click();
  await toolbar.getByLabel("配置名称", { exact: true }).fill("夜间学习");
  await toolbar.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(toolbar.getByRole("status")).toHaveText("已保存「夜间学习」");
  await page.reload(); await expect(title).toHaveValue("Late Night Lofi | Study and Rest"); await expect(picker).toHaveValue(nightId);

  // 新浏览器上下文没有原 sessionStorage，仍可从服务端选择已保存配置。
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fresh = await other.newPage(); await fresh.goto(origin + "/workspace");
  const freshPanel = fresh.locator("#instance-preview_liang-main");
  const freshBar = freshPanel.getByRole("region", { name: "直播配置", exact: true });
  await expect(freshBar.getByLabel("直播配置", { exact: true })).toBeEnabled();
  await freshBar.getByLabel("直播配置", { exact: true }).selectOption(nightId); await freshBar.getByRole("button", { name: "使用配置", exact: true }).click();
  await expect(freshPanel.locator('[id^="broadcast-title-"]')).toHaveValue("Late Night Lofi | Study and Rest");
  await other.close();

  // 第二标签页修订冲突不能覆盖，刷新列表后仍保留当前输入。
  const query = new URLSearchParams({ agentId: "preview_liang", instanceId: "main", channelId: "demo_preview_liang_main" });
  const saved = await (await context.request.get(origin + "/api/broadcast-profiles?" + query)).json();
  const night = saved.profiles.find(profile => profile.id === nightId);
  await context.request.post(origin + "/api/broadcast-profiles", { headers: { origin, "x-livepilot": "1" }, data: { action: "save", target: Object.fromEntries(query), id: night.id, revision: night.revision, name: night.name, selection: { ...night.selection, broadcast: { ...night.selection.broadcast, title: "Concurrent edit" } } } });
  await title.fill("My preserved draft"); await toolbar.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(toolbar.getByRole("alert")).toContainText("其他页面更新"); await expect(title).toHaveValue("My preserved draft");
  await toolbar.getByRole("button", { name: "重新读取配置", exact: true }).click();
  await expect(toolbar.getByRole("status")).toContainText("草稿已保留");
  await title.fill("Late Night Lofi | Study and Rest"); await toolbar.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(toolbar.getByRole("status")).toHaveText("已保存「夜间学习」");

  // 临时配置删除后草稿保留；正式演示的两套配置留给本机预览。
  await saveAs(toolbar, "待删除配置"); await toolbar.getByLabel("管理直播配置", { exact: true }).click();
  await toolbar.getByRole("button", { name: "删除配置", exact: true }).click();
  await toolbar.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(toolbar.getByRole("status")).toContainText("当前草稿已保留"); await expect(title).toHaveValue("Late Night Lofi | Study and Rest");
  await picker.selectOption(nightId);
  await expect(picker).toHaveValue(nightId); // 内容相同，仅恢复选中标签。
  await page.getByRole("navigation", { name: "工作空间", exact: true }).getByRole("link", { name: "视频发布", exact: true }).click();
  await page.getByRole("button", { name: "视频发布配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "视频发布配置", exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: path.join(output, "video-profile-names.png"), fullPage: true });
  await page.getByRole("navigation", { name: "工作空间", exact: true }).getByRole("link", { name: "直播工作台", exact: true }).click();
  await expect(title).toHaveValue("Late Night Lofi | Study and Rest");
  await expect(first.getByRole("tab", { name: "直播选项", exact: true })).toBeVisible();
  const measurements = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await first.getByRole("tab", { name: "直播内容", exact: true }).focus();
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: "instant" }); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const measured = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(measured.scrollWidth <= width + 1, "无横向溢出"); measurements.push(measured);
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`), fullPage: true });
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.ok(writes.every(body => ["save", "delete"].includes(body.action)));
  await writeFile(path.join(output, "measurements.json"), JSON.stringify({ measurements, pageErrors: errors, profileWrites: writes.length, persistence: "real isolated preview API", liveOperations: "none" }, null, 2));
  console.log("PASS: two saved profiles, fresh-browser reuse, replace/cancel/undo, failed save, rename/delete, revision conflict, module draft retention, 1440/390/320 layouts");
} finally { await browser.close(); }
