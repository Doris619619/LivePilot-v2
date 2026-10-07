/** 批次删除浏览器验收：合成 Cloud 响应，不连接客户 Agent、YouTube 或真实素材。 */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3077";
const output = path.resolve(".data/publishing-removal-ui"); await mkdir(output, { recursive: true });
const policy = { enabled: true, publicVerified: true, projectKey: "synthetic", uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: "synthetic@example.invalid", verificationNote: "" };
const accountId = "11111111-1111-4111-8111-111111111111";
const profile = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, name: "常规发布", agentId: "pc", instanceId: "main", accountId, channelId: "synthetic_channel", titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", playlistIds: [], privacy: "public", scheduled: true, madeForKids: false, license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "none", ai: { enabled: false, language: "English", prompt: "Generate", fallbackTitle: "{{packageName}}", fallbackDescription: "" }, schedule: { timezone: "UTC", weekdays: [1], localTime: "18:00", startDate: "2030-10-01", preuploadDays: 28 } };
const rule = { timezone: "UTC", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 };
/** 文件与任务只提供前端事实，未实际创建或读取视频。 */
function batch(name, state, legacy = false) {
  const id = crypto.randomUUID(); const asset = { id: "a".repeat(64), version: "b".repeat(64), filename: "video.mp4", size: 1000000, mtimeMs: 1, sha256: null, hashState: "not_computed" };
  const pkg = { id: "c".repeat(64), version: "d".repeat(64), batchName: name, name: name + " 视频", sourceVideo: asset, validationState: "valid", issues: [] };
  const spec = { id: crypto.randomUUID(), batchId: id, owner: "alice", actor: "alice", revision: 1, desired: "run", profile: { ...profile, name: legacy ? name : profile.name }, asset, contentPackage: legacy ? undefined : pkg, plan: rule, index: 1, originalPublishAt: "2030-10-07T18:00:00Z", overrides: {}, policy, consent: { version: "2026-10-01", acceptedAt: 1, ai: false, temporaryPrivateTitle: true } };
  const job = { spec, hadUpload: true, createdAt: 1, observed: { id: spec.id, revision: 1, sequence: 1, state, offset: asset.size, total: asset.size, updatedAt: 1, videoId: "synthetic_" + state, observedPrivacy: state === "published" ? "public" : "private", effectivePublishAt: spec.originalPublishAt, metadata: { title: pkg.name, description: "Synthetic" } } };
  return { id, name, job, plan: legacy ? undefined : { id, revision: 1, owner: "alice", actor: "alice", profile, batch: { id: "e".repeat(64), version: "f".repeat(64), name, packages: [pkg], issues: [] }, rule, items: [{ packageId: pkg.id, scheduleSource: "auto", excluded: false, publishAt: spec.originalPublishAt }], copies: [{ packageId: pkg.id, title: pkg.name, description: "Synthetic" }], skippedOccupied: 0, skipped: [], createdAt: 1, confirmedAt: 2 } };
}
const active = batch("待发布批次", "scheduled"); const done = batch("完成批次", "published"); const legacy = batch("旧版批次", "published", true);
const secondAccountId = "22222222-2222-4222-8222-222222222222";
done.job.spec.profile = { ...profile, accountId: secondAccountId, channelId: "second_channel" }; done.plan.profile = done.job.spec.profile;
const view = { accounts: [{ id: accountId, agentId: "pc", instanceId: "main", name: "测试账号", channelId: profile.channelId, channel: "测试频道", owner: "alice", status: "connected", createdAt: 1, updatedAt: 1 }], profiles: [profile], plans: [active.plan, done.plan], jobs: [active.job, done.job, legacy.job], removals: [], cleanups: [], policy, consent: { version: "2026-10-01" }, administrator: false };
view.accounts.push({ ...view.accounts[0], id: secondAccountId, channelId: "second_channel", channel: "另一频道" });
const requests = []; const errors = []; let rejectNext = true; let devices; let inventoryFails = false; let holdInventory = false; let inventoryStarted; const heldInventory = [];
const browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", error => errors.push(error.message));
await page.clock.install();
/** 白名单 mock 保证删除确认只能写到合成批次，所有意外操作直接失败。 */
await page.route(origin + "/api/**", async route => {
  const url = new URL(route.request().url()); let result;
  if (url.pathname === "/api/session") result = { user: { username: "alice", role: "customer" } };
  else if (url.pathname === "/api/accounts") result = { accounts: [{ username: "alice", role: "customer", current: true }] };
  else if (url.pathname === "/api/instances") { if (holdInventory) await new Promise(resolve => { heldInventory.push(resolve); inventoryStarted?.(); }); if (inventoryFails) { await route.fulfill({ status: 503, json: { error: "Synthetic device read unavailable" } }); return; } result = { agents: devices, instances: [{ id: "main", name: "Main", agentId: "pc", agentName: "测试电脑" }] }; }
  else if (url.pathname === "/api/agents/pc/publishing-directory") result = { root: "D:\\Synthetic\\Publishing" };
  else if (url.pathname === "/api/publishing" && route.request().method() === "GET") result = view;
  else if (url.pathname === "/api/publishing") {
    const body = route.request().postDataJSON();
    if (body.action === "packages") { await route.fulfill({ json: { root: "D:\\Synthetic\\Publishing", batches: [], thumbnails: [], channelId: profile.channelId } }); return; }
    assert.equal(body.action, "batch-remove"); requests.push(body);
    if (rejectNext) { rejectNext = false; await route.fulfill({ status: 409, json: { error: "批次正在归档，请稍后再删除。" } }); return; }
    const removal = { batchId: body.batchId, requestedAt: Date.now(), ...(body.batchId !== active.id ? { completedAt: Date.now() } : {}) }; view.removals.push(removal);
    if (body.batchId === active.id) { active.job.spec.desired = "cancel"; active.job.spec.revision++; }
    result = { batchId: body.batchId, removal, state: removal.completedAt ? "complete" : "pending" };
  }
  assert.ok(result, "Unexpected mock endpoint: " + url.pathname); await route.fulfill({ json: result });
});
try {
  await page.goto(origin + "/publishing"); await page.getByRole("button", { name: "我的发布", exact: true }).click();
  const card = () => page.getByRole("article", { name: "批次 " + active.name, exact: true });
  const deletion = () => card().getByRole("button", { name: "删除批次：" + active.name, exact: true });
  await deletion().waitFor(); assert.equal(await deletion().isVisible(), true);
  await page.screenshot({ path: path.join(output, "overview-1440.png"), fullPage: true });
  await deletion().click(); let dialog = page.getByRole("dialog", { name: "删除批次" });
  await dialog.getByRole("button", { name: "保留批次" }).click(); assert.equal(requests.length, 0);
  assert.equal(await deletion().evaluate(element => element === document.activeElement), true);
  await deletion().focus(); await page.keyboard.press("Enter"); await dialog.waitFor(); await page.keyboard.press("Escape"); assert.equal(requests.length, 0);
  await card().getByRole("button", { name: "查看详情" }).click();
  await page.getByText("操作与详情", { exact: true }).click(); await page.getByRole("button", { name: "改期", exact: true }).click();
  await page.getByRole("button", { name: "提交改期", exact: true }).waitFor();
  await page.getByRole("button", { name: "删除批次：" + active.name }).click(); await dialog.getByRole("button", { name: "确认删除" }).click();
  await dialog.getByRole("alert").waitFor(); assert.equal(await dialog.isVisible(), true); assert.ok((await dialog.getByRole("alert").innerText()).includes("批次正在归档"));
  await dialog.getByRole("button", { name: "确认删除" }).click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "删除待确认：" + active.name }).waitFor();
  await page.getByText("删除待确认。未确认前，已排期的视频仍可能公开。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "改期", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "提交改期", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).count(), 0);
  devices = [{ id: "pc", online: false, maintenance: false }];
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("设备离线，打开这台电脑的 LiveNest 后会继续删除。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 950 }); await page.screenshot({ path: path.join(output, "offline-detail-320.png"), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  devices[0].online = true;
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("删除待确认。未确认前，已排期的视频仍可能公开。", { exact: true }).waitFor();
  assert.equal(await page.getByText("设备离线，打开这台电脑的 LiveNest 后会继续删除。", { exact: true }).count(), 0);
  devices[0].maintenance = true;
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("设备正在维护，完成后会继续删除。", { exact: true }).waitFor();
  devices = undefined;
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("删除待确认。未确认前，已排期的视频仍可能公开。", { exact: true }).waitFor();
  devices = [{ id: "pc", online: false, maintenance: false }];
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("设备离线，打开这台电脑的 LiveNest 后会继续删除。", { exact: true }).waitFor();
  inventoryFails = true; await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("删除待确认。未确认前，已排期的视频仍可能公开。", { exact: true }).waitFor();
  assert.equal(await page.getByText("设备离线，打开这台电脑的 LiveNest 后会继续删除。", { exact: true }).count(), 0); inventoryFails = false;
  await page.getByRole("button", { name: "返回总览" }).click();
  assert.equal(await card().isVisible(), true);
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await card().getByText("等待设备上线", { exact: true }).waitFor();
  await card().getByText("设备离线，打开这台电脑的 LiveNest 后会继续删除。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "offline-overview-1440.png"), fullPage: true });
  active.job.observed.revision = active.job.spec.revision; active.job.observed.state = "needs_attention"; active.job.observed.message = "合成取消失败，请核对原频道。";
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await card().getByText("删除需处理", { exact: true }).waitFor(); await card().getByText(active.job.observed.message, { exact: true }).waitFor();
  await card().getByRole("button", { name: "查看详情" }).click(); await page.getByText("操作与详情", { exact: true }).click(); await page.getByRole("button", { name: "取消任务", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回总览" }).click(); active.job.observed.revision--; active.job.observed.state = "scheduled"; delete active.job.observed.message;
  devices[0].online = true; await page.getByRole("button", { name: "刷新发布状态" }).click(); await card().getByText("删除待确认", { exact: true }).waitFor();
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 }); const button = page.getByRole("article", { name: "批次 " + done.name }).getByRole("button", { name: "删除批次：" + done.name });
    await button.scrollIntoViewIfNeeded(); const bounds = await button.boundingBox(); assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
    await button.click(); await dialog.waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, "confirm-" + width + ".png") }); await dialog.getByRole("button", { name: "保留批次" }).click();
  }
  await page.getByRole("article", { name: "批次 " + done.name }).getByRole("button", { name: "查看详情" }).click();
  await page.getByRole("button", { name: "删除批次：" + done.name }).click(); await dialog.getByRole("button", { name: "确认删除" }).click();
  await page.getByRole("article", { name: "批次 " + done.name }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "删除批次：视频任务 · " + legacy.name }).click(); await dialog.getByRole("button", { name: "确认删除" }).click();
  await page.getByRole("article", { name: "批次 视频任务 · " + legacy.name }).waitFor({ state: "hidden" });
  const started = new Promise(resolve => { inventoryStarted = resolve; }); holdInventory = true;
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.clock.runFor(10001); await started;
  const removal = view.removals.find(value => value.batchId === active.id); removal.completedAt = Date.now(); active.job.observed.state = "cancelled"; active.job.observed.revision = active.job.spec.revision;
  await page.clock.runFor(11001); await card().waitFor({ state: "hidden", timeout: 3000 }); assert.ok(heldInventory.length > 0);
  holdInventory = false; for (const release of heldInventory.splice(0)) release();
  await page.getByRole("button", { name: "历史", exact: true }).click(); await page.getByText(done.name + " 视频", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看" + done.name + " 视频详情" }).click(); await page.getByText("批次已移出总览，历史记录保留。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "核对状态", exact: true }).count(), 0); assert.equal(view.jobs.length, 3); assert.equal(view.plans.length, 2);
  await page.getByRole("combobox", { name: "发布频道" }).selectOption(profile.channelId);
  assert.equal(await page.getByRole("combobox", { name: "发布频道" }).inputValue(), profile.channelId);
  assert.equal(await page.getByText(done.name + " 视频", { exact: true }).count(), 0); assert.equal(await page.getByText(legacy.name + " 视频", { exact: true }).isVisible(), true);
  view.removals.push({ batchId: crypto.randomUUID(), requestedAt: Date.now(), name: "记录缺失批次" });
  await page.getByRole("button", { name: "刷新发布状态" }).click(); await page.getByText("记录缺失批次：删除未确认，任务记录不可用。请到 YouTube Studio 检查未公开排期。", { exact: true }).waitFor();
  await page.evaluate(({ id, accountId, rule }) => localStorage.setItem("livenest-publishing-draft:alice:pc:main:" + accountId, JSON.stringify({ planId: id, batchId: "e".repeat(64), step: 4, rule })), { id: active.id, accountId, rule });
  await page.reload(); await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(requests.length, 4); assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, widths: [320, 390, 1024, 1440], requests: requests.length, deviceFeedback: ["offline", "online", "maintenance", "unknown", "read-failure", "cancel-failure", "slow-inventory-does-not-block-completion"], synthetic: true }, null, 2));
  process.stdout.write("Batch removal UI passed: visible actions, keyboard confirmation, failed submission, offline/online/maintenance/unknown feedback, cancellation retry entry, pending/complete, legacy/history/draft, four widths.\n");
} finally { for (const release of heldInventory) release(); await browser.close(); }
