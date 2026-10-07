/** 上传前检查浏览器回归：所有状态、素材和 API 均为合成数据，不接触 Agent 或 YouTube。 */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3079";
const output = path.resolve(".data/publishing-upload-review-ui"); await mkdir(output, { recursive: true });
const widths = [320, 390, 1024, 1440]; const screenshots = [];
const accountId = "11111111-1111-4111-8111-111111111111";
const policy = { enabled: true, publicVerified: true, projectKey: "synthetic", uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: "synthetic@example.invalid", verificationNote: "" };
const profile = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, name: "常规发布", agentId: "pc", instanceId: "main", accountId, channelId: "synthetic_channel", titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", playlistIds: [], privacy: "public", scheduled: true, madeForKids: false, license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "none", ai: { enabled: false, language: "English", prompt: "Generate", fallbackTitle: "{{packageName}}", fallbackDescription: "" }, schedule: { timezone: "UTC", weekdays: [1], localTime: "18:00", startDate: "2030-10-01", preuploadDays: 28 } };
const rule = { timezone: "UTC", startDate: "2030-10-01", weeklySlots: [{ weekday: 1, time: "18:00" }], preuploadDays: 28 };
const backendMessage = "该发布包已有上传记录；先核对并取消旧任务，可能已上传的新版本需明确确认替代上传。";

/** 稳定索引只作为前端快照；未创建、读取或上传视频文件。 */
function digest(number) { return number.toString(16).padStart(64, "0"); }
/** 为每次浏览器上下文创建独立草稿；旧批次已移除，公开历史仍在。 */
function fixture(known = true) {
  const packages = [1, 2, 3].map(index => ({ id: digest(index), version: digest(index + 100), batchName: "我的第一批次", name: String(index).padStart(3, "0"), sourceVideo: { id: digest(index + 200), version: digest(index + 300), filename: "video.mp4", size: 40000000, mtimeMs: 1, sha256: null, hashState: "not_computed" }, validationState: "valid", issues: [] }));
  const batch = { id: digest(400), version: digest(500), name: "我的第一批次", packages, issues: [] };
  const oldId = "22222222-2222-4222-8222-222222222222"; const draftId = "33333333-3333-4333-8333-333333333333";
  const plan = { id: draftId, revision: 1, owner: "alice", actor: "alice", profile: structuredClone(profile), batch: structuredClone(batch), rule: structuredClone(rule), items: packages.map((pkg, index) => ({ packageId: pkg.id, excluded: false, scheduleSource: "auto", publishAt: `2030-10-${String(7 + index * 7).padStart(2, "0")}T18:00:00.000Z` })), copies: packages.map(pkg => ({ packageId: pkg.id, title: pkg.name, description: "Synthetic description" })), skippedOccupied: 0, skipped: [], createdAt: 10 };
  const old = { ...structuredClone(plan), id: oldId, batch: { ...structuredClone(batch), packages: structuredClone(packages.slice(0, 2)) }, items: structuredClone(plan.items.slice(0, 2)), copies: structuredClone(plan.copies.slice(0, 2)), confirmedAt: 2, createdAt: 1 };
  const jobs = packages.slice(0, 2).map((pkg, index) => {
    const id = index ? "55555555-5555-4555-8555-555555555555" : "44444444-4444-4444-8444-444444444444";
    const contentPackage = structuredClone(pkg); if (!known) contentPackage.id = digest(index + 900);
    const spec = { id, batchId: oldId, owner: "alice", actor: "alice", revision: 3, desired: "cancel", profile: structuredClone(profile), asset: pkg.sourceVideo, contentPackage, plan: structuredClone(rule), index: index + 1, originalPublishAt: old.items[index].publishAt, overrides: {}, policy, consent: { version: "2026-10-01", acceptedAt: 1, ai: false, temporaryPrivateTitle: true } };
    return { spec, hadUpload: true, createdAt: 1, observed: { id, revision: 3, sequence: 3, state: "published", videoId: "synthetic_video_" + pkg.name, offset: pkg.sourceVideo.size, total: pkg.sourceVideo.size, updatedAt: Date.parse("2030-10-01T12:00:00Z") + index * 60000, observedPrivacy: "public", effectivePublishAt: spec.originalPublishAt, metadata: { title: pkg.name, description: "Synthetic description" }, message: "视频已公开，取消未应用。" } };
  });
  return { batch, plan, requests: [], errors: [], unexpected: [], view: { accounts: [{ id: accountId, agentId: "pc", instanceId: "main", name: "测试发布账号", channelId: profile.channelId, channel: "测试频道", owner: "alice", status: "connected", createdAt: 1, updatedAt: 1 }], profiles: [structuredClone(profile)], plans: [old, plan], jobs, removals: [{ batchId: oldId, requestedAt: 3, completedAt: 4, name: batch.name }], cleanups: [], policy, consent: { version: "2026-10-01" }, administrator: false } };
}

/** 只允许同源页面及白名单合成 API；意外端点和外部视频请求立即记录为失败。 */
async function createPage(browser, data, draftStep = 3) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
  page.on("pageerror", error => data.errors.push(error.message));
  await context.addInitScript(({ accountId, plan, rule, draftStep }) => {
    const targetKey = "livenest-publishing-target:alice"; const draftKey = "livenest-publishing-draft:alice:pc:main:" + accountId;
    if (!localStorage.getItem(targetKey)) localStorage.setItem(targetKey, JSON.stringify({ agentId: "pc", instanceId: "main", accountId }));
    if (!localStorage.getItem(draftKey)) localStorage.setItem(draftKey, JSON.stringify({ planId: plan.id, batchId: plan.batch.id, profileId: plan.profile.id, rule, excluded: [], step: draftStep }));
  }, { accountId, plan: data.plan, rule, draftStep });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { data.unexpected.push("External request: " + url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    try {
      let result;
      if (url.pathname === "/api/session") result = { user: { username: "alice", role: "customer" } };
      else if (url.pathname === "/api/accounts") result = { accounts: [{ username: "alice", role: "customer", current: true }] };
      else if (url.pathname === "/api/instances") result = { agents: [{ id: "pc", online: true, maintenance: false }], instances: [{ id: "main", name: "发布实例", agentId: "pc", agentName: "测试电脑" }] };
      else if (url.pathname === "/api/agents/pc/publishing-directory") result = { root: "D:\\Synthetic\\Publishing" };
      else if (url.pathname === "/api/publishing" && route.request().method() === "GET") result = data.view;
      else if (url.pathname === "/api/publishing") {
        const body = route.request().postDataJSON(); data.requests.push(body);
        if (body.action === "packages") result = { root: "D:\\Synthetic\\Publishing", batches: [data.batch], thumbnails: [], channelId: profile.channelId, channel: "测试频道" };
        else if (body.action === "plan-update") {
          assert.equal(body.planId, data.plan.id); assert.equal(body.revision, data.plan.revision); data.plan.revision++; data.plan.rule = body.rule; data.plan.items = body.items; result = data.plan;
        } else if (body.action === "plan-confirm") {
          assert.equal(body.planId, data.plan.id); assert.equal(body.revision, data.plan.revision);
          await route.fulfill({ status: 409, json: { error: backendMessage } }); return;
        }
      }
      assert.ok(result, "Unexpected mock endpoint: " + route.request().method() + " " + url.pathname); await route.fulfill({ json: result });
    } catch (error) { data.unexpected.push(error.message); await route.fulfill({ status: 500, json: { error: "Synthetic mock rejected an unexpected request." } }); }
  });
  await page.goto(origin + "/publishing"); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  return { context, page };
}
/** 每次截图验证整页横向边界，覆盖桌面月历和移动端日程。 */
async function capture(page, name) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const offenders = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "absolute").map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })).slice(0, 15));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Horizontal overflow in " + name + ": " + JSON.stringify(offenders));
  await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
}
/** 全局读取/操作错误不应显示新草稿的确认失败。 */
async function noGlobalError(page, location) { assert.equal(await page.locator(".publishing-error:visible").count(), 0, "Unexpected global error in " + location); }
/** 草稿只读持久化检查，页面切换不能丢失计划与时间规则。 */
async function savedDraft(page) { return page.evaluate(accountId => JSON.parse(localStorage.getItem("livenest-publishing-draft:alice:pc:main:" + accountId)), accountId); }
/** 所有合成回归都必须在没有浏览器异常和未声明请求时才算通过。 */
function checkFixture(data, name) { assert.deepEqual(data.errors, [], name + " browser errors"); assert.deepEqual(data.unexpected, [], name + " unexpected requests"); }

const browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
try {
  const known = fixture(); const first = await createPage(browser, known); const { page } = first;
  const confirmation = () => page.getByRole("region", { name: "确认发布计划", exact: true });
  await confirmation().getByText("2 条视频已在此频道公开，不能重复上传。", { exact: true }).waitFor();
  assert.equal(await confirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).isDisabled(), true);
  assert.equal(await confirmation().getByRole("checkbox").count(), 0, "Blocked draft must not invite upload consent");
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await capture(page, "blocked-confirm-" + width + ".png"); }
  await page.setViewportSize({ width: 1440, height: 1000 }); const beforeHistory = await savedDraft(page);
  await confirmation().getByRole("button", { name: "查看发布记录", exact: true }).click();
  await page.getByRole("table", { name: "发布历史记录" }).waitFor(); await noGlobalError(page, "history reached from duplicate warning");
  assert.equal(await page.getByRole("button", { name: "历史", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("cell", { name: "已公开", exact: true }).count(), 2);
  await page.getByRole("button", { name: "查看001详情", exact: true }).click();
  await page.getByText("批次已移除 · YouTube 视频保留", { exact: true }).waitFor();
  assert.equal(await page.getByText("视频已公开，取消未应用。", { exact: true }).count(), 0, "Removed public history must state the user outcome");
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await capture(page, "removed-public-history-" + width + ".png"); }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole("button", { name: "发布视频", exact: true }).click();
  await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.deepEqual(await savedDraft(page), beforeHistory, "Opening historical publication must preserve the unconfirmed draft");
  await confirmation().getByRole("button", { name: "更换素材", exact: true }).click();
  await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "下一步", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "检测素材", exact: true }).click();
  await page.getByRole("checkbox", { name: /暂不发布.*001/ }).check(); await page.getByRole("checkbox", { name: /暂不发布.*002/ }).check();
  assert.equal(await page.getByRole("region", { name: "已有发布记录", exact: true }).count(), 0, "Excluded duplicates must not block the new package");
  assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*003/ }).isChecked(), false);
  await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("heading", { name: "设置时间", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  await confirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ }).check();
  assert.equal(await confirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).isEnabled(), true);
  assert.deepEqual(known.plan.items.filter(item => item.excluded).map(item => item.packageId), known.batch.packages.slice(0, 2).map(pkg => pkg.id));
  assert.equal(known.requests.filter(request => request.action === "plan-confirm").length, 0, "Known duplicate materials must never submit an upload");
  await page.reload(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.deepEqual((await savedDraft(page)).excluded, known.batch.packages.slice(0, 2).map(pkg => pkg.id), "Refresh must restore excluded duplicates");
  checkFixture(known, "known duplicate and exclusion"); await first.context.close();

  const raced = fixture(false); const second = await createPage(browser, raced); const racePage = second.page;
  const raceConfirmation = () => racePage.getByRole("region", { name: "确认发布计划", exact: true });
  assert.equal(await raceConfirmation().getByRole("region", { name: "已有发布记录", exact: true }).count(), 0);
  await raceConfirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ }).check();
  await raceConfirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).click();
  await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor(); await noGlobalError(racePage, "failed confirmation");
  const failedDraft = await savedDraft(racePage);
  for (const width of widths) { await racePage.setViewportSize({ width, height: 1000 }); await capture(racePage, "local-confirm-error-" + width + ".png"); }
  await racePage.getByRole("button", { name: "我的发布", exact: true }).click(); await racePage.getByRole("button", { name: "历史", exact: true }).click();
  await racePage.getByRole("table", { name: "发布历史记录" }).waitFor(); await noGlobalError(racePage, "history after failed confirmation");
  assert.equal(await racePage.getByRole("alert").filter({ hasText: backendMessage }).count(), 0, "New draft confirmation failure must not appear in historical video results");
  await racePage.getByRole("button", { name: "发布视频", exact: true }).click(); await racePage.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor();
  assert.deepEqual(await savedDraft(racePage), failedDraft, "Returning to the same failed revision must retain the draft");
  await racePage.getByRole("button", { name: "刷新发布状态" }).click(); await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor();
  assert.equal(raced.requests.filter(request => request.action === "plan-confirm").length, 1); assert.equal(raced.view.jobs.length, 2); assert.equal(raced.plan.confirmedAt, undefined);
  checkFixture(raced, "server conflict error isolation"); await second.context.close();

  const changed = fixture(false); const third = await createPage(browser, changed, 2); const changedPage = third.page;
  // 已保存的未确认计划优先恢复到确认页；先返回设置，再模拟后台发现此前缺失的旧上传记录。
  await changedPage.getByRole("button", { name: "返回设置", exact: true }).click(); await changedPage.getByRole("heading", { name: "设置时间", exact: true }).waitFor();
  assert.equal((await savedDraft(changedPage)).step, 2); assert.equal(await changedPage.getByRole("button", { name: "生成排期", exact: true }).isEnabled(), true);
  for (const [index, job] of changed.view.jobs.entries()) job.spec.contentPackage = structuredClone(changed.batch.packages[index]);
  await changedPage.getByRole("button", { name: "刷新发布状态" }).click();
  await changedPage.getByRole("region", { name: "已有发布记录", exact: true }).getByText("2 条视频已在此频道公开，不能重复上传。", { exact: true }).waitFor();
  assert.equal(await changedPage.getByRole("button", { name: "生成排期", exact: true }).isDisabled(), true, "Newly discovered duplicate history must disable schedule generation and explain why");
  await noGlobalError(changedPage, "duplicate discovered while setting times");
  for (const width of widths) { await changedPage.setViewportSize({ width, height: 1000 }); await capture(changedPage, "blocked-time-settings-" + width + ".png"); }
  await changedPage.getByRole("button", { name: "更换素材", exact: true }).click(); await changedPage.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(await changedPage.getByRole("button", { name: "下一步", exact: true }).isDisabled(), true);
  assert.equal(changed.requests.filter(request => request.action !== "packages").length, 0, "Newly discovered duplicate history must not submit a plan: " + JSON.stringify(changed.requests));
  checkFixture(changed, "duplicate history discovered in time settings"); await third.context.close();
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, synthetic: true, widths, screenshots, knownConfirmRequests: 0, racedConfirmRequests: 1, checks: ["removed-public-duplicates-block-before-consent", "direct-history-entry-preserves-draft", "public-history-clear-removal-outcome", "excluded-duplicates-release-new-material", "refresh-retains-exclusions", "server-conflict-local-to-plan-revision", "history-never-shows-draft-error", "same-revision-retains-error-after-return-and-refresh", "time-settings-explain-and-block-newly-discovered-duplicates"] }, null, 2));
  process.stdout.write("Upload review UI passed: early duplicate protection, clear retained-public history, excluded duplicate recovery, draft persistence, local confirmation conflict, and four viewport widths. All API and file data were synthetic.\n");
} finally { await browser.close(); }
