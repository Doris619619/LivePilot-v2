/** 重复发布及上传预检浏览器回归：所有状态、素材和 API 均为合成数据，不接触 Agent 或 YouTube。 */
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
const lostResponseMessage = "提交响应中断，请重试。";

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
  return { batch, plan, confirmMode: "success", confirmedJobs: [], requests: [], errors: [], unexpected: [], view: { accounts: [{ id: accountId, agentId: "pc", instanceId: "main", name: "测试发布账号", channelId: profile.channelId, channel: "测试频道", owner: "alice", status: "connected", createdAt: 1, updatedAt: 1 }], profiles: [structuredClone(profile)], plans: [old, plan], jobs, removals: [{ batchId: oldId, requestedAt: 3, completedAt: 4, name: batch.name }], cleanups: [], policy, consent: { version: "2026-10-01" }, administrator: false } };
}

/** 计算当前合成 API 可接受的终态 allowlist；这个 mock 不替代 Cloud 的真实事务/幂等测试。 */
function expectedRepeats(data) {
  const selected = new Set(data.plan.items.filter(item => !item.excluded).map(item => item.packageId));
  return data.view.jobs.filter(job => job.spec.batchId !== data.plan.id && selected.has(job.spec.contentPackage?.id) && job.observed?.revision === job.spec.revision && ["published", "completed"].includes(job.observed.state)).map(job => job.spec.id).sort();
}

/** 模拟确认返回丢失后仍沿用同一计划；只为新任务分配 ID，不覆写旧视频关联。 */
function syntheticConfirmation(data) {
  if (!data.confirmedJobs.length) data.confirmedJobs = data.plan.items.filter(item => !item.excluded).map((item, index) => {
    const pkg = data.plan.batch.packages.find(pkg => pkg.id === item.packageId);
    return { spec: { ...structuredClone(data.view.jobs[0].spec), id: "66666666-6666-4666-8666-" + String(index + 1).padStart(12, "0"), batchId: data.plan.id, desired: "run", revision: 1, contentPackage: structuredClone(pkg), asset: structuredClone(pkg.sourceVideo), originalPublishAt: item.publishAt }, createdAt: 20 };
  });
  return data.confirmedJobs;
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
          if (data.confirmMode === "reject") { await route.fulfill({ status: 409, json: { error: backendMessage } }); return; }
          assert.deepEqual([...(body.republishJobIds || [])].sort(), expectedRepeats(data), "Repeat confirmation must explicitly identify every selected prior job");
          assert.equal(body.temporaryPrivateTitle, true); assert.equal(body.ai, false);
          result = syntheticConfirmation(data);
          if (data.confirmMode === "lose-response-once") { data.confirmMode = "success"; await route.fulfill({ status: 503, json: { error: lostResponseMessage } }); return; }
          data.plan.confirmedAt = 20;
          if (body.republishJobIds?.length) data.plan.republishJobIds = [...body.republishJobIds];
          for (const job of result) if (!data.view.jobs.some(value => value.spec.id === job.spec.id)) data.view.jobs.push(job);
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
  const consent = () => confirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ });
  const repeat = count => confirmation().getByRole("checkbox", { name: "再次发布这 " + count + " 条视频，原视频保留。", exact: true });
  const submit = () => confirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true });
  await confirmation().getByText("2 条视频已发布，可再次发布。", { exact: true }).waitFor();
  assert.equal(await repeat(2).isChecked(), false, "Repeating old public videos is never selected implicitly");
  await consent().check(); assert.equal(await submit().isDisabled(), true, "Ordinary upload consent cannot authorize intentional repeat publication");
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await capture(page, "repeat-confirm-" + width + ".png"); }
  await repeat(2).check(); assert.equal(await submit().isEnabled(), true);
  await page.setViewportSize({ width: 1440, height: 1000 }); const beforeHistory = await savedDraft(page);
  await confirmation().getByRole("button", { name: "查看发布记录", exact: true }).click();
  await page.getByRole("table", { name: "发布历史记录" }).waitFor(); await noGlobalError(page, "history reached from repeat notice");
  assert.equal(await page.getByRole("button", { name: "历史", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("cell", { name: "已公开", exact: true }).count(), 2);
  await page.getByRole("button", { name: "查看001详情", exact: true }).click();
  await page.getByText("批次已移除 · YouTube 视频保留", { exact: true }).waitFor();
  assert.equal(await page.getByText("视频已公开，取消未应用。", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "查看视频", exact: true }).getAttribute("href"), "https://www.youtube.com/watch?v=synthetic_video_001");
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await capture(page, "removed-public-history-" + width + ".png"); }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole("button", { name: "发布视频", exact: true }).click();
  await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.deepEqual(await savedDraft(page), beforeHistory, "Opening old publication preserves the draft");
  assert.equal(await repeat(2).isChecked(), true, "Viewing history alone does not alter the same confirmation snapshot");
  await confirmation().getByRole("button", { name: "更换素材", exact: true }).click();
  await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "下一步", exact: true }).isEnabled(), true, "Known completed videos can reach time settings");
  await page.getByRole("button", { name: "检测素材", exact: true }).click();
  await page.getByRole("checkbox", { name: /暂不发布.*001/ }).check();
  await page.getByRole("region", { name: "已有发布记录", exact: true }).getByText("1 条视频已发布，可再次发布。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("heading", { name: "设置时间", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "生成排期", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.equal(await repeat(1).isChecked(), false, "Changing candidates resets prior repeat consent");
  await consent().check(); assert.equal(await submit().isDisabled(), true);
  await repeat(1).check(); assert.equal(await submit().isEnabled(), true);
  assert.deepEqual(known.plan.items.filter(item => item.excluded).map(item => item.packageId), [known.batch.packages[0].id]);
  assert.equal(known.requests.filter(request => request.action === "plan-confirm").length, 0);
  await confirmation().getByRole("button", { name: "更换素材", exact: true }).click();
  await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  await page.getByRole("checkbox", { name: /暂不发布.*002/ }).check();
  assert.equal(await page.getByRole("region", { name: "已有发布记录", exact: true }).count(), 0, "Excluded old packages release new content");
  await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("button", { name: "生成排期", exact: true }).click();
  await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor(); await consent().check();
  assert.equal(await confirmation().getByRole("checkbox", { name: /再次发布这/ }).count(), 0);
  assert.equal(await submit().isEnabled(), true, "Remaining new package needs ordinary consent only");
  await page.reload(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.deepEqual((await savedDraft(page)).excluded, known.batch.packages.slice(0, 2).map(pkg => pkg.id));
  checkFixture(known, "repeat candidate navigation and exclusion"); await first.context.close();

  const retry = fixture(); retry.confirmMode = "lose-response-once"; const oldPublic = structuredClone(retry.view.jobs);
  const second = await createPage(browser, retry); const retryPage = second.page;
  const retryConfirmation = () => retryPage.getByRole("region", { name: "确认发布计划", exact: true });
  const retrySubmit = () => retryConfirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true });
  await retryConfirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ }).check();
  await retryConfirmation().getByRole("checkbox", { name: "再次发布这 2 条视频，原视频保留。", exact: true }).check();
  await retrySubmit().click(); await retryConfirmation().getByRole("alert").filter({ hasText: lostResponseMessage }).waitFor();
  await noGlobalError(retryPage, "lost confirm response"); assert.equal(retry.confirmedJobs.length, 3);
  await retrySubmit().click(); await retryPage.getByRole("heading", { name: "自动执行", exact: true }).waitFor();
  const execution = retryPage.getByRole("region", { name: "批次执行状态", exact: true });
  await execution.getByRole("heading", { name: "我的第一批次 · 再次发布", exact: true }).waitFor();
  assert.equal(await execution.locator(".publishing-execution-summary > div").filter({ has: retryPage.locator("dt").filter({ hasText: /^已公开$/ }) }).locator("dd").innerText(), "0", "This new round never inherits old public counts");
  assert.equal(await execution.locator(".publishing-execution-summary > div").filter({ has: retryPage.locator("dt").filter({ hasText: /^待处理$/ }) }).locator("dd").innerText(), "3");
  const retryRequests = retry.requests.filter(request => request.action === "plan-confirm");
  assert.equal(retryRequests.length, 2); assert.deepEqual(retryRequests[1], retryRequests[0], "Retry uses the same plan and explicit repeat allowlist");
  assert.deepEqual([...retryRequests[0].republishJobIds].sort(), oldPublic.map(job => job.spec.id).sort());
  assert.equal(retry.view.jobs.length, 5, "Synthetic idempotent confirmation exposes one set of new jobs");
  assert.deepEqual(retry.view.jobs.slice(0, 2), oldPublic, "Original public jobs and video IDs are retained");
  await retryPage.getByRole("button", { name: "我的发布", exact: true }).click();
  await retryPage.getByRole("heading", { name: "我的第一批次 · 再次发布", exact: true }).waitFor();
  await retryPage.getByText("已公开 0", { exact: true }).waitFor(); await retryPage.getByText("待发布 3", { exact: true }).waitFor();
  await retryPage.getByRole("button", { name: "历史", exact: true }).click();
  await retryPage.getByRole("table", { name: "发布历史记录" }).waitFor(); assert.equal(await retryPage.getByRole("cell", { name: "已公开", exact: true }).count(), 2);
  await retryPage.getByRole("button", { name: "查看002详情", exact: true }).click();
  assert.equal(await retryPage.getByRole("link", { name: "查看视频", exact: true }).getAttribute("href"), "https://www.youtube.com/watch?v=synthetic_video_002");
  const repeatedJob = retry.view.jobs.find(job => job.spec.batchId === retry.plan.id);
  repeatedJob.observed = { id: repeatedJob.spec.id, revision: repeatedJob.spec.revision, sequence: 1, state: "published", videoId: "synthetic_repeat_001", offset: repeatedJob.spec.asset.size, total: repeatedJob.spec.asset.size, updatedAt: Date.parse("2030-10-02T12:00:00Z"), observedPrivacy: "public", metadata: { title: "001", description: "New synthetic publication" } };
  await retryPage.getByRole("button", { name: "刷新发布状态" }).click();
  await retryPage.getByRole("cell", { name: "我的第一批次 · 再次发布", exact: true }).waitFor();
  assert.equal(await retryPage.getByRole("cell", { name: "我的第一批次", exact: true }).count(), 2, "Only the new historical round receives the repeat marker");
  checkFixture(retry, "explicit repeat confirmation retry"); await second.context.close();

  const changed = fixture(); const fourth = await createPage(browser, changed); const changedPage = fourth.page;
  const changedConfirmation = () => changedPage.getByRole("region", { name: "确认发布计划", exact: true });
  await changedConfirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ }).check();
  await changedConfirmation().getByRole("checkbox", { name: "再次发布这 2 条视频，原视频保留。", exact: true }).check();
  const additional = structuredClone(changed.view.jobs[0]); additional.spec.id = "77777777-7777-4777-8777-777777777777"; additional.observed.id = additional.spec.id; additional.observed.videoId = "synthetic_video_001_again";
  changed.view.jobs.push(additional); await changedPage.getByRole("button", { name: "刷新发布状态" }).click();
  await changedPage.waitForFunction(() => [...document.querySelectorAll('input[type="checkbox"]')].some(input => input.parentElement?.textContent?.includes("再次发布这") && !input.checked));
  assert.equal(await changedConfirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).isDisabled(), true, "New historical IDs invalidate repeat consent even without plan revision changes");
  assert.equal(changed.requests.filter(request => request.action === "plan-confirm").length, 0);
  checkFixture(changed, "repeat consent tracks historical job identities"); await fourth.context.close();

  const unknown = fixture(); unknown.view.jobs[0].observed.state = "needs_attention"; unknown.view.jobs[0].spec.revision++;
  unknown.view.jobs[1].observed.state = "uploading"; unknown.view.jobs[1].spec.desired = "run";
  const fifth = await createPage(browser, unknown); const unknownPage = fifth.page;
  const unknownConfirmation = () => unknownPage.getByRole("region", { name: "确认发布计划", exact: true });
  await unknownConfirmation().getByRole("region", { name: "已有发布记录", exact: true }).waitFor();
  assert.equal(await unknownConfirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).isDisabled(), true);
  assert.equal(await unknownConfirmation().getByRole("checkbox", { name: /再次发布这/ }).count(), 0, "Unknown cancellation and active upload are not intentional repeat candidates");
  for (const width of widths) { await unknownPage.setViewportSize({ width, height: 1000 }); await capture(unknownPage, "unknown-upload-blocked-" + width + ".png"); }
  await unknownPage.getByRole("button", { name: "准备素材", exact: true }).click(); await unknownPage.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(await unknownPage.getByRole("button", { name: "下一步", exact: true }).isDisabled(), true);
  assert.equal(unknown.requests.filter(request => request.action === "plan-confirm").length, 0);
  checkFixture(unknown, "unknown cancellation and active upload protection"); await fifth.context.close();

  const raced = fixture(false); raced.confirmMode = "reject"; const third = await createPage(browser, raced); const racePage = third.page;
  const raceConfirmation = () => racePage.getByRole("region", { name: "确认发布计划", exact: true });
  assert.equal(await raceConfirmation().getByRole("region", { name: "已有发布记录", exact: true }).count(), 0);
  await raceConfirmation().getByRole("checkbox", { name: /确认频道、内容和时间/ }).check();
  await raceConfirmation().getByRole("button", { name: "确认上传并按计划发布", exact: true }).click();
  await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor(); await noGlobalError(racePage, "failed confirmation");
  const failedDraft = await savedDraft(racePage);
  for (const width of widths) { await racePage.setViewportSize({ width, height: 1000 }); await capture(racePage, "local-confirm-error-" + width + ".png"); }
  await racePage.getByRole("button", { name: "我的发布", exact: true }).click(); await racePage.getByRole("button", { name: "历史", exact: true }).click();
  await racePage.getByRole("table", { name: "发布历史记录" }).waitFor(); await noGlobalError(racePage, "history after failed confirmation");
  assert.equal(await racePage.getByRole("alert").filter({ hasText: backendMessage }).count(), 0);
  await racePage.getByRole("button", { name: "发布视频", exact: true }).click(); await racePage.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor();
  assert.deepEqual(await savedDraft(racePage), failedDraft);
  await racePage.getByRole("button", { name: "刷新发布状态" }).click(); await raceConfirmation().getByRole("alert").filter({ hasText: backendMessage }).waitFor();
  assert.equal(raced.requests.filter(request => request.action === "plan-confirm").length, 1); assert.equal(raced.view.jobs.length, 2); assert.equal(raced.plan.confirmedAt, undefined);
  checkFixture(raced, "server conflict error isolation"); await third.context.close();

  const discovered = fixture(false); const sixth = await createPage(browser, discovered, 2); const discoveredPage = sixth.page;
  await discoveredPage.getByRole("button", { name: "返回设置", exact: true }).click(); await discoveredPage.getByRole("heading", { name: "设置时间", exact: true }).waitFor();
  assert.equal(await discoveredPage.getByRole("button", { name: "生成排期", exact: true }).isEnabled(), true);
  for (const [index, job] of discovered.view.jobs.entries()) { job.spec.contentPackage = structuredClone(discovered.batch.packages[index]); job.observed.state = "uploading"; job.spec.desired = "run"; }
  await discoveredPage.getByRole("button", { name: "刷新发布状态" }).click();
  await discoveredPage.getByRole("region", { name: "已有发布记录", exact: true }).waitFor();
  assert.equal(await discoveredPage.getByRole("button", { name: "生成排期", exact: true }).isDisabled(), true, "New unknown upload must block and explain schedule generation");
  await noGlobalError(discoveredPage, "active uploads discovered while setting times");
  for (const width of widths) { await discoveredPage.setViewportSize({ width, height: 1000 }); await capture(discoveredPage, "blocked-time-settings-" + width + ".png"); }
  await discoveredPage.getByRole("button", { name: "更换素材", exact: true }).click(); await discoveredPage.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  assert.equal(await discoveredPage.getByRole("button", { name: "下一步", exact: true }).isDisabled(), true);
  assert.equal(discovered.requests.filter(request => request.action !== "packages").length, 0);
  checkFixture(discovered, "in-progress history discovered in time settings"); await sixth.context.close();

  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, synthetic: true, backendIdempotencyIsMocked: true, widths, screenshots, repeatConfirmRequests: retryRequests.length, racedConfirmRequests: 1, checks: ["finished-history-continues-to-settings", "explicit-repeat-checkbox-required", "repeat-payload-identifies-prior-jobs", "confirmation-retry-retains-plan-and-allowlist", "old-video-links-retained", "repeat-round-starts-independent-statistics", "repeat-round-marked-in-overview-execution-history", "candidate-exclusions-reset-consent", "new-historical-ids-reset-consent", "excluded-old-content-releases-new-content", "refresh-retains-exclusions", "unknown-cancellation-never-reuploads", "in-progress-history-blocks-new-generation", "direct-history-entry-preserves-draft", "server-conflict-local-to-plan-revision"] }, null, 2));
  process.stdout.write("Upload review UI passed: explicit intentional repeats, same-plan retry payload, retained old video references, unknown upload protection, consent reset, draft persistence, and four viewport widths. All API and file data were synthetic; backend idempotency was mocked.\n");
} finally { await browser.close(); }
