/** 四步发布浏览器验收：覆盖可点击步骤、草稿保留与100个模拟发布包，不连接真实Agent、OBS或YouTube。 */
import { chromium } from "playwright";
import { Temporal } from "@js-temporal/polyfill";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3077";
const output = path.resolve(".data/publishing-ui"); await mkdir(output, { recursive: true });
const policy = { enabled: true, publicVerified: true, projectKey: "synthetic", uploadsPerDay: 20, otherUnitsPerDay: 5000, concurrency: 1, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600, chunkBytes: 8388608, pollBatchSize: 50, processingPollSeconds: 60, scheduledPollSeconds: 1800, tickSeconds: 60, privacyContact: "synthetic@example.invalid", verificationNote: "" };
/** 合成轻量文件快照，不读取任何用户素材。 */
function asset(index, filename) { return { id: index.toString(16).padStart(64, "0"), version: (index + 10000).toString(16).padStart(64, "0"), filename, size: 32000000, mtimeMs: 1, sha256: null, hashState: "not_computed" }; }
/** 每批100包；第一批两项故意缺少/包含多个主视频。 */
function batch(name, index, invalid) {
  return { id: (index + 20000).toString(16).padStart(64, "0"), name, version: (index + 30000).toString(16).padStart(64, "0"), issues: [], packages: Array.from({ length: 100 }, (_, i) => {
    const number = i + 1; const broken = invalid && [3, 7].includes(number);
    return { id: (number + index * 1000).toString(16).padStart(64, "0"), batchName: name, name: String(number).padStart(3, "0"), version: (number + index * 2000).toString(16).padStart(64, "0"), ...(number !== 3 || !invalid ? { sourceVideo: asset(number + index * 1000, "video.mp4") } : {}), ...(number % 3 ? { sourceMusic: asset(number + index * 4000, "music.mp3") } : {}), ...(number % 2 ? { cover: asset(number + index * 5000, "cover.jpg") } : {}), validationState: broken ? "invalid" : "valid", issues: broken ? [number === 3 ? "缺少 video" : "多个 video"] : [] };
  }) };
}
const batches = [batch("2030-10-Batch-01", 1, true), batch("2030-10-Batch-02", 2, false)];
const accountOne = "11111111-1111-4111-8111-111111111111"; const accountTwo = "22222222-2222-4222-8222-222222222222"; const accountThree = "33333333-3333-4333-8333-333333333333";
const accounts = [
  { id: accountOne, agentId: "pc", instanceId: "main", name: "音乐发布账号", owner: "alice", status: "connected", channelId: "channel_one", channel: "Rainy Night Radio", createdAt: 1, updatedAt: 1, connectedAt: 1 },
  { id: accountTwo, agentId: "pc_two", instanceId: "main", name: "第二发布账号", owner: "alice", status: "connected", channelId: "channel_two", channel: "第二频道", createdAt: 1, updatedAt: 1, connectedAt: 1 },
  { id: accountThree, agentId: "pc", instanceId: "main", name: "同机独立账号", owner: "alice", status: "connected", channelId: "channel_three", channel: "第三频道", createdAt: 1, updatedAt: 1, connectedAt: 1 },
];
const profile = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, name: "常规发布", agentId: "pc", instanceId: "main", accountId: accountOne, channelId: "channel_one", titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", playlistIds: [], privacy: "public", scheduled: true, madeForKids: false, license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "matching", ai: { enabled: false, language: "English", prompt: "Generate accurate copy", fallbackTitle: "{{packageName}}", fallbackDescription: "" }, schedule: { timezone: "UTC", weekdays: [1, 3, 5, 7], localTime: "18:00", startDate: "2030-10-01", preuploadDays: 28 } };
const thirdProfile = { ...structuredClone(profile), id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", accountId: accountThree, channelId: "channel_three" };
const view = { accounts, profiles: [profile, thirdProfile], jobs: [], plans: [], cleanups: [], policy, administrator: false };
let confirmed; let latestPlan; let createdAccount; const errors = []; const actions = []; const screenshots = []; const archiveRequests = []; const legacyRequests = []; const accountConnectRequests = []; const oauthResultRequests = []; const schedulePreviews = new Map();
const browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
/** 模拟服务端自动排期；首六个时刻已占用，manual覆盖固定保留。 */
function allocate(plan) {
  let date = Temporal.PlainDate.from(plan.rule.startDate); const options = []; const used = new Set(plan.items.filter(item => !item.excluded && item.scheduleSource === "manual" && item.publishAt).map(item => item.publishAt));
  while (options.length < plan.items.length + 6) {
    for (const slot of plan.rule.weeklySlots.filter(item => item.weekday === date.dayOfWeek).sort((a, b) => a.time.localeCompare(b.time))) {
      const instant = date.toPlainDateTime(Temporal.PlainTime.from(slot.time)).toZonedDateTime(plan.rule.timezone).toInstant().toString({ fractionalSecondDigits: 3 });
      if (!used.has(instant)) options.push(instant);
    }
    date = date.add({ days: 1 });
  }
  let position = 6;
  plan.items = plan.items.map(item => item.excluded || item.scheduleSource === "manual" ? item : { ...item, publishAt: options[position++] });
  plan.skippedOccupied = 6; plan.copies = plan.items.map(item => ({ packageId: item.packageId, title: item.title ?? plan.batch.packages.find(pkg => pkg.id === item.packageId).name, description: item.description ?? "A quiet evening." }));
  return plan;
}
/** 模拟确认后排期预览：保留人工和已固定的任务，只改变尚可调整的自动时间。 */
function reschedule(plan, rule, items) {
  const related = view.jobs.filter(job => job.spec.batchId === plan.id);
  const locked = plan.items.filter(item => { const job = related.find(job => job.spec.contentPackage.id === item.packageId); return item.excluded || !job || job.spec.desired === "cancel" || ["published", "completed", "cancelled", "failed", "needs_attention"].includes(job.observed.state); }).map(item => item.packageId);
  const fixed = new Map(plan.items.filter(item => locked.includes(item.packageId) || item.scheduleSource === "manual").map(item => [item.packageId, item]));
  for (const item of items) { const original = plan.items.find(value => value.packageId === item.packageId); assert.equal(item.excluded, original.excluded); assert.equal(item.title, original.title); assert.equal(item.description, original.description); }
  const next = allocate({ ...structuredClone(plan), rule: structuredClone(rule), items: items.map(item => fixed.has(item.packageId) ? { ...fixed.get(item.packageId), scheduleSource: "manual" } : structuredClone(item)) });
  next.items = next.items.map(item => fixed.has(item.packageId) ? structuredClone(fixed.get(item.packageId)) : item); next.copies = structuredClone(plan.copies);
  next.schedulePreviewId = crypto.randomUUID(); next.scheduleLockedPackageIds = locked;
  schedulePreviews.set(next.schedulePreviewId, next); return next;
}
/** 浏览器可见的上传身份、已生成文案和最终文件描述不能随改期变化。 */
function uploadFacts(jobs) { return structuredClone(jobs.map(job => ({ id: job.spec.id, asset: job.spec.asset, contentPackage: job.spec.contentPackage, profile: job.spec.profile, overrides: job.spec.overrides, metadata: job.observed.metadata, videoId: job.observed.videoId, prepared: job.prepared, observedPrepared: job.observed.prepared }))); }
/** 所有API限定为预设模拟端点，未声明请求直接使验收失败。 */
async function mock(route) {
  const url = new URL(route.request().url()); const body = route.request().postDataJSON(); let result;
  if (url.pathname === "/api/session") result = { user: { username: "alice", role: "customer" } };
  else if (url.pathname === "/api/instances") result = { instances: [{ id: "main", name: "音乐频道", agentId: "pc", agentName: "工作室电脑" }, { id: "main", name: "第二频道", agentId: "pc_two", agentName: "另一台电脑" }] };
  else if (url.pathname === "/api/status") { legacyRequests.push(url.pathname); result = { youtube: { connected: true, authorization: "present", channelId: "live_channel", channel: "Existing Live Channel" } }; }
  else if (url.pathname === "/api/broadcast-assets") { legacyRequests.push(url.pathname); result = { playlists: [{ id: "PLsynthetic", title: "Rainy Night Sessions" }] }; }
  else if (url.pathname === "/api/youtube/result") { assert.equal(url.searchParams.get("id"), "55555555-5555-4555-8555-555555555555"); oauthResultRequests.push(url.searchParams.get("id")); result = { target: { agentId: "pc_two", instanceId: "main" }, accountId: accountTwo, status: "connected" }; }
  else if (url.pathname === "/api/publishing") {
    if (!body) result = view;
    else {
      actions.push(body.action);
      if (body.action === "consent") { view.consent = { version: body.version }; result = { ok: true }; }
      if (body.action === "packages") { const account = view.accounts.find(value => value.id === body.accountId); assert.ok(account); assert.equal(account.agentId, body.agentId); assert.equal(account.instanceId, body.instanceId); result = { root: body.agentId === "pc" ? "D:\\LIVENEST\\Publishing" : "E:\\LiveNest\\Publishing", batches: body.agentId === "pc" ? batches : [batches[1]], thumbnails: [], channelId: account.channelId, channel: account.channel }; }
      if (body.action === "account-playlists") { assert.equal(body.accountId, accountOne); result = { playlists: [{ id: "PLsynthetic", title: "Rainy Night Sessions" }] }; }
      if (body.action === "account-create") { assert.equal(body.agentId, "pc"); assert.equal(body.instanceId, "main"); createdAccount = { id: "44444444-4444-4444-8444-444444444444", agentId: body.agentId, instanceId: body.instanceId, name: body.name, owner: "alice", status: "unbound", createdAt: Date.now(), updatedAt: Date.now() }; view.accounts.push(createdAccount); result = createdAccount; }
      if (body.action === "account-connect") { accountConnectRequests.push(body.accountId); assert.equal(body.accountId, createdAccount.id); result = { url: origin + "/publishing?synthetic-account=" + body.accountId }; }
      if (body.action === "profile") { const index = view.profiles.findIndex(value => value.id === body.profile.id); if (index >= 0) view.profiles[index] = body.profile; else view.profiles.push(body.profile); result = body.profile; }
      if (body.action === "plan-preview") {
        latestPlan = allocate({ id: crypto.randomUUID(), revision: 1, owner: "alice", actor: "alice", profile: structuredClone(view.profiles.find(value => value.id === body.profileId)), batch: structuredClone(batches.find(value => value.id === body.batchId)), rule: body.rule, items: body.items, copies: [], skippedOccupied: 0, skipped: [], createdAt: Date.now() });
        view.plans.push(latestPlan); result = latestPlan;
      }
      if (body.action === "plan-update") {
        latestPlan = view.plans.find(value => value.id === body.planId); assert.equal(body.revision, latestPlan.revision); latestPlan.revision++; latestPlan.rule = body.rule || latestPlan.rule; latestPlan.items = body.items; allocate(latestPlan); result = latestPlan;
      }
      if (body.action === "plan-confirm") {
        confirmed = body; latestPlan = view.plans.find(value => value.id === body.planId); assert.equal(body.revision, latestPlan.revision); latestPlan.confirmedAt = Date.now();
        result = latestPlan.items.filter(item => !item.excluded).map((item, i) => {
          const pkg = latestPlan.batch.packages.find(value => value.id === item.packageId);
          const spec = { id: crypto.randomUUID(), batchId: latestPlan.id, owner: "alice", actor: "alice", revision: 1, desired: "run", asset: pkg.sourceVideo, contentPackage: pkg, plan: latestPlan.rule, scheduleSource: item.scheduleSource, profile: latestPlan.profile, originalPublishAt: item.publishAt, index: i + 1, policy, overrides: {}, consent: { version: "2026-10-01", acceptedAt: Date.now(), ai: false, temporaryPrivateTitle: true } };
          return { spec, createdAt: Date.now(), observed: { id: spec.id, revision: 1, sequence: 1, state: i === 0 ? "preparing_media" : i === 1 ? "uploading" : i < 17 ? "scheduled" : "ready", offset: i === 1 ? 8000000 : 0, total: spec.asset.size, updatedAt: Date.now(), ...(i < 17 && i > 1 ? { effectivePublishAt: item.publishAt } : {}) } };
        });
        view.jobs.push(...result);
      }
      if (body.action === "plan-reschedule-preview") { const plan = view.plans.find(value => value.id === body.planId); assert.ok(plan.confirmedAt); assert.equal(body.revision, plan.revision); result = reschedule(plan, body.rule, body.items); }
      if (body.action === "plan-reschedule-confirm") {
        const plan = view.plans.find(value => value.id === body.planId); const preview = schedulePreviews.get(body.previewId); assert.ok(preview); assert.equal(preview.id, plan.id); assert.equal(body.revision, plan.revision);
        for (const job of view.jobs.filter(value => value.spec.batchId === plan.id)) {
          if (preview.scheduleLockedPackageIds.includes(job.spec.contentPackage.id)) continue;
          const item = preview.items.find(value => value.packageId === job.spec.contentPackage.id);
          if (job.spec.originalPublishAt !== item.publishAt) job.pendingPublishAt ??= job.observed.effectivePublishAt || job.spec.originalPublishAt;
          job.spec.originalPublishAt = item.publishAt; job.spec.scheduleSource = item.scheduleSource; job.spec.plan = structuredClone(preview.rule); job.spec.revision++;
        }
        const next = structuredClone(preview); delete next.schedulePreviewId; delete next.scheduleLockedPackageIds; next.revision = plan.revision + 1; Object.assign(plan, next); latestPlan = plan; result = plan;
      }
      if (body.action === "job") {
        const job = view.jobs.find(value => value.spec.id === body.id); job.spec.desired = body.operation === "pause" ? "pause" : body.operation === "resume" ? "run" : body.operation === "cancel" ? "cancel" : "run"; job.spec.revision++;
        if (body.operation === "resume") job.observed.revision = job.spec.revision; result = job;
      }
      if (body.action === "plan-archive") { archiveRequests.push(body.planId); const plan = view.plans.find(value => value.id === body.planId); plan.archivePending = true; result = { state: "pending" }; }
      if (body.action === "account-cleanup") { assert.equal(body.accountId, accountOne); assert.equal(body.confirmed, true); view.jobs = view.jobs.filter(job => job.spec.profile.accountId !== body.accountId); view.profiles = view.profiles.filter(profile => profile.accountId !== body.accountId); view.plans = view.plans.filter(plan => plan.profile.accountId !== body.accountId); const account = view.accounts.find(value => value.id === body.accountId); account.status = "cleanup_pending"; result = { id: "cleanup", accountId: account.id, agentId: account.agentId, instanceId: account.instanceId, deadline: Date.now() + 7 * 86400000, state: "pending" }; view.cleanups.push(result); }
    }
  }
  assert.ok(result, "Unexpected mocked request: " + url.pathname); await route.fulfill({ json: result });
}
/** 步骤导航按标签定位，排除页面内同名标题和操作按钮。 */
function stepButton(page, name) { return page.locator(".publishing-steps").getByRole("button", { name: new RegExp(name) }); }
/** 每次切换都核对当前步骤的辅助技术语义和实际内容区域。 */
async function expectStep(page, name) {
  await page.getByRole("heading", { name, exact: true }).waitFor();
  assert.equal(await page.locator('.publishing-steps button[aria-current="step"]').count(), 1);
  assert.equal(await stepButton(page, name).getAttribute("aria-current"), "step");
  assert.equal(await page.locator("#publishing-step-content").count(), 1);
}
/** 截图前清除焦点，检查无横向溢出，以及小屏步骤导航可触摸且关联内容。 */
async function capture(page, name) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
  const overflowing = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "absolute").map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })).slice(0, 20));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Overflow in " + name + ": " + JSON.stringify(overflowing));
  if (await page.locator(".publishing-steps:visible").count()) {
    const buttons = page.locator(".publishing-steps:visible button"); assert.equal(await buttons.count(), 4);
    for (const button of await buttons.all()) {
      assert.equal(await button.getAttribute("aria-controls"), "publishing-step-content");
      if (page.viewportSize().width <= 390) {
        const bounds = await button.boundingBox(); assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, "Step touch target under 44px in " + name);
      }
    }
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", error => errors.push(error.message)); await page.route("**/api/**", mock);
  await page.goto(origin + "/publishing"); await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
  await expectStep(page, "准备素材"); assert.equal(await stepButton(page, "设置时间").isDisabled(), true); assert.equal(await stepButton(page, "确认计划").isDisabled(), true);
  assert.equal(await page.getByLabel("发布账号", { exact: true }).inputValue(), accountOne); assert.equal(await page.getByLabel("发布账号", { exact: true }).locator("option").count(), 3);
  assert.equal(await page.locator('nav[aria-label="发布功能"] button').count(), 2); assert.equal(await page.getByRole("button", { name: "发布策略", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "检测素材", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "同意并继续" }).click(); await page.getByRole("button", { name: "检测素材", exact: true }).click();
  await page.getByText("缺少 video", { exact: true }).waitFor(); assert.equal(await page.locator(".publishing-package-row").count(), 25);
  assert.equal(await page.getByRole("button", { name: "下一步", exact: true }).isDisabled(), true);
  await page.getByRole("checkbox", { name: /暂不发布.*003/ }).check(); await page.getByRole("checkbox", { name: /暂不发布.*007/ }).check();
  assert.equal(await page.getByRole("button", { name: "下一步", exact: true }).isDisabled(), false);
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "packages-" + width + ".png"); }
  await page.getByLabel("设备", { exact: true }).selectOption("pc_two:main"); assert.equal(await page.locator(".publishing-package-row").count(), 0);
  await page.getByRole("button", { name: "检测素材", exact: true }).click(); await page.getByText("E:\\LiveNest\\Publishing\\Inbox", { exact: true }).waitFor();
  await page.getByLabel("设备", { exact: true }).selectOption("pc:main"); await page.getByRole("button", { name: "检测素材", exact: true }).click(); await page.getByText("缺少 video", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*003/ }).isChecked(), true);
  await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("heading", { name: "设置时间", exact: true }).waitFor();
  await page.getByRole("button", { name: "新建配置", exact: true }).click(); await page.getByRole("heading", { name: "新建配置", exact: true }).waitFor();
  assert.equal(await page.getByLabel("标题模板").inputValue(), "{{packageName}}"); assert.equal(await page.getByText("每周排期", { exact: true }).count(), 0);
  await page.getByText("标签与播放列表", { exact: true }).click(); await page.getByRole("button", { name: "读取播放列表", exact: true }).click(); await page.getByRole("checkbox", { name: "Rainy Night Sessions", exact: true }).check(); assert.equal(actions.filter(action => action === "account-playlists").length, 1);
  await page.getByLabel("是否专为儿童制作").selectOption("false"); await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByRole("heading", { name: "设置时间", exact: true }).waitFor(); await page.getByLabel("开始日期", { exact: true }).fill("2030-10-01"); await page.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await page.getByLabel("周一发布时间", { exact: true }).fill("18:00"); await page.getByLabel("周三发布时间", { exact: true }).fill("20:00"); await page.getByLabel("周五发布时间", { exact: true }).fill("18:00"); await page.getByLabel("周日发布时间", { exact: true }).fill("12:00");
  await page.getByRole("button", { name: "周一添加时间", exact: true }).click(); assert.equal(await page.getByLabel("周一发布时间 2", { exact: true }).count(), 1); await page.getByRole("button", { name: "删除周一时间 2", exact: true }).click();
  await stepButton(page, "准备素材").focus(); await page.keyboard.press("Enter"); await expectStep(page, "准备素材");
  assert.equal(await page.getByRole("heading", { name: "准备素材", exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*003/ }).isChecked(), true); assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*007/ }).isChecked(), true);
  await page.getByRole("checkbox", { name: /暂不发布.*003/ }).uncheck(); assert.equal(await stepButton(page, "设置时间").isDisabled(), true); assert.equal(await stepButton(page, "确认计划").isDisabled(), true);
  await page.getByRole("checkbox", { name: /暂不发布.*003/ }).check(); await stepButton(page, "设置时间").click(); await expectStep(page, "设置时间");
  assert.equal(await page.getByLabel("开始日期", { exact: true }).inputValue(), "2030-10-01"); assert.equal(await page.getByLabel("时区", { exact: true }).inputValue(), "Asia/Shanghai"); assert.equal(await page.getByLabel("周三发布时间", { exact: true }).inputValue(), "20:00");
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "schedule-" + width + ".png"); }
  await page.getByLabel("发布账号", { exact: true }).selectOption(accountThree); await expectStep(page, "准备素材"); await page.getByRole("button", { name: "检测素材", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*003/ }).isChecked(), false); await page.getByRole("radio", { name: /2030-10-Batch-02/ }).check(); await page.getByRole("button", { name: "下一步", exact: true }).click();
  assert.equal(await page.getByLabel("发布频道", { exact: true }).inputValue(), "第三频道"); await page.getByLabel("开始日期", { exact: true }).fill("2030-11-01"); await page.getByLabel("周三发布时间", { exact: true }).fill("09:00");
  await page.getByLabel("发布账号", { exact: true }).selectOption(accountOne); await expectStep(page, "设置时间"); assert.equal(await page.getByLabel("开始日期", { exact: true }).inputValue(), "2030-10-01"); assert.equal(await page.getByLabel("周三发布时间", { exact: true }).inputValue(), "20:00"); assert.equal(await page.getByLabel("时区", { exact: true }).inputValue(), "Asia/Shanghai");
  await stepButton(page, "准备素材").click(); await expectStep(page, "准备素材"); assert.equal(await page.getByRole("checkbox", { name: /暂不发布.*003/ }).isChecked(), true); await stepButton(page, "设置时间").click(); await expectStep(page, "设置时间");
  await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.equal(latestPlan.profile.accountId, accountOne); assert.equal(latestPlan.items.filter(item => !item.excluded).length, 98); assert.equal(latestPlan.skippedOccupied, 6); assert.equal(latestPlan.rule.weeklySlots.find(slot => slot.weekday === 3).time, "20:00");
  assert.equal(await page.getByRole("button", { name: "日历", exact: true }).getAttribute("aria-pressed"), "true"); await page.locator('[aria-label="发布排期日历"]').waitFor();
  await page.getByRole("button", { name: "下个月", exact: true }).click(); assert.equal(await page.getByRole("button", { name: "编辑发布包 001", exact: true }).count(), 0);
  await page.getByRole("button", { name: "上个月", exact: true }).click(); await page.getByRole("button", { name: "编辑发布包 001", exact: true }).click();
  const title = page.getByLabel("标题", { exact: true }); await title.fill("🌙".repeat(101)); assert.equal(await page.getByRole("button", { name: "保存修改", exact: true }).isDisabled(), true);
  await title.fill("🌙".repeat(100)); assert.equal(await title.getAttribute("maxlength"), null); assert.equal(await page.getByRole("button", { name: "保存修改", exact: true }).isDisabled(), false);
  await title.fill("东京雨夜 · Tokyo Rainy Night"); await page.getByLabel("发布时间 · Asia/Shanghai", { exact: true }).fill("2030-10-10T00:30"); await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.locator(".publishing-plan-month").getByText("手动", { exact: true }).waitFor(); const manualAt = latestPlan.items.find(item => item.packageId === batches[0].packages[0].id).publishAt;
  assert.equal(manualAt, "2030-10-09T16:30:00.000Z");
  const manualDay = page.locator('[data-date="2030-10-10"]'); assert.equal(await manualDay.getByRole("button", { name: "编辑发布包 001", exact: true }).count(), 1);
  await page.reload(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor(); await page.locator(".publishing-plan-month").getByText("手动", { exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑发布包 001", exact: true }).click(); await page.getByLabel("标题", { exact: true }).fill("未保存的午夜标题");
  await stepButton(page, "准备素材").click(); await expectStep(page, "准备素材"); await stepButton(page, "确认计划").click(); await expectStep(page, "确认计划");
  assert.equal(await page.getByLabel("标题", { exact: true }).inputValue(), "未保存的午夜标题"); assert.equal(await page.getByLabel("发布时间 · Asia/Shanghai", { exact: true }).inputValue(), "2030-10-10T00:30");
  assert.equal(latestPlan.items.find(item => item.packageId === batches[0].packages[0].id).title, "东京雨夜 · Tokyo Rainy Night"); await page.locator(".publishing-plan-editor").getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(actions.filter(action => action === "plan-preview").length, 1);
  await stepButton(page, "设置时间").click(); await expectStep(page, "设置时间"); await page.getByLabel("周三发布时间", { exact: true }).fill("21:00"); await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.equal(latestPlan.items.find(item => item.packageId === batches[0].packages[0].id).publishAt, manualAt); assert.equal(actions.filter(action => action === "plan-preview").length, 1);
  await page.getByRole("button", { name: "列表", exact: true }).click(); assert.equal(await page.locator(".publishing-plan-item").count(), 25);
  const firstPageNames = await page.locator(".publishing-plan-item button").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
  await page.getByRole("button", { name: "下一页", exact: true }).click(); assert.equal(await page.locator(".publishing-plan-item").count(), 25);
  const secondPageNames = await page.locator(".publishing-plan-item button").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label"))); assert.equal(secondPageNames.some(name => firstPageNames.includes(name)), false);
  await page.getByRole("button", { name: "上一页", exact: true }).click(); assert.deepEqual(await page.locator(".publishing-plan-item button").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label"))), firstPageNames);
  await page.getByRole("button", { name: "编辑发布包 002", exact: true }).click(); await page.getByRole("checkbox", { name: "暂不发布", exact: true }).check(); await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).isDisabled(), true); await page.getByRole("checkbox", { name: /^确认频道、内容和时间/ }).check();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "confirmation-" + width + ".png"); }
  console.log("Publishing smoke: draft navigation, independent accounts and calendar passed.");
  await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).click(); await page.getByRole("heading", { name: "自动执行", exact: true }).waitFor();
  await expectStep(page, "自动执行"); for (const name of ["准备素材", "设置时间", "确认计划"]) assert.equal(await stepButton(page, name).isDisabled(), false);
  assert.equal(confirmed.revision, latestPlan.revision); assert.equal(view.jobs.length, 97); assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).isDisabled(), true);
  const firstJobs = view.jobs.filter(job => job.spec.batchId === latestPlan.id); const beforeReschedule = structuredClone(latestPlan); const firstJobIds = firstJobs.map(job => job.spec.id);
  for (const job of firstJobs) { const copy = latestPlan.copies.find(value => value.packageId === job.spec.contentPackage.id); job.observed.metadata = { title: copy.title, description: copy.description }; }
  firstJobs[2].spec.desired = "pause"; firstJobs[2].observed.state = "paused"; firstJobs[2].observed.videoId = "existing_paused_video";
  firstJobs[3].observed.state = "published"; firstJobs[3].observed.videoId = "existing_public_video"; firstJobs[3].observed.observedPrivacy = "public";
  firstJobs[4].spec.desired = "cancel"; firstJobs[4].observed.state = "cancelled"; firstJobs[5].observed.state = "needs_attention"; firstJobs[6].observed.state = "failed";
  for (const job of [firstJobs[1], firstJobs[2]]) { job.prepared = { version: "a".repeat(64), size: 32000000, sha256: "9".repeat(64) }; job.observed.prepared = structuredClone(job.prepared); }
  const immutableUploads = uploadFacts(firstJobs); const fixedJobs = [firstJobs[0], ...firstJobs.slice(3, 7)].map(job => ({ id: job.spec.id, time: job.spec.originalPublishAt }));
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await stepButton(page, "确认计划").click(); await expectStep(page, "确认计划");
  assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).count(), 0); assert.equal(await page.getByRole("checkbox", { name: /^确认频道、内容和时间/ }).count(), 0);
  await page.getByRole("button", { name: "返回执行", exact: true }).click(); await expectStep(page, "自动执行"); await stepButton(page, "准备素材").click(); await expectStep(page, "准备素材");
  for (const checkbox of await page.getByRole("checkbox", { name: /暂不发布/ }).all()) assert.equal(await checkbox.isDisabled(), true);
  assert.equal(await page.getByRole("radio").count(), 0); assert.equal(await page.getByRole("button", { name: "检测素材", exact: true }).count(), 0);
  await stepButton(page, "设置时间").click(); await expectStep(page, "设置时间"); assert.equal(await page.getByLabel("发布配置", { exact: true }).getAttribute("readonly"), ""); assert.equal(await page.getByRole("button", { name: "新建配置", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("周三发布时间", { exact: true }).inputValue(), "21:00"); await page.getByLabel("周三发布时间", { exact: true }).fill("22:00"); await page.getByRole("button", { name: "返回执行", exact: true }).click(); await expectStep(page, "自动执行");
  assert.deepEqual(latestPlan.rule, beforeReschedule.rule); assert.equal(actions.filter(action => action === "plan-reschedule-preview").length, 0);
  await stepButton(page, "设置时间").click(); await expectStep(page, "设置时间"); assert.equal(await page.getByLabel("周三发布时间", { exact: true }).inputValue(), "22:00");
  await page.reload(); await expectStep(page, "设置时间"); assert.equal(await page.getByLabel("周三发布时间", { exact: true }).inputValue(), "22:00"); assert.equal(await page.getByLabel("时区", { exact: true }).inputValue(), "Asia/Shanghai");
  await page.getByRole("button", { name: "预览新排期", exact: true }).click(); await expectStep(page, "确认计划");
  assert.equal(await page.getByRole("button", { name: "编辑发布包 006", exact: true }).isDisabled(), true); await page.getByRole("button", { name: "编辑发布包 004", exact: true }).click();
  assert.equal(await page.getByLabel("标题", { exact: true }).count(), 0); assert.equal(await page.getByLabel("说明", { exact: true }).count(), 0); assert.equal(await page.getByRole("checkbox", { name: "暂不发布", exact: true }).count(), 0); await page.getByLabel("发布时间 · Asia/Shanghai", { exact: true }).waitFor();
  await page.locator(".publishing-plan-editor").getByRole("button", { name: "返回", exact: true }).click(); await page.getByRole("button", { name: "返回执行", exact: true }).click(); await expectStep(page, "自动执行");
  assert.deepEqual(latestPlan.rule, beforeReschedule.rule); assert.deepEqual(uploadFacts(firstJobs), immutableUploads);
  await stepButton(page, "设置时间").click(); await page.getByRole("button", { name: "预览新排期", exact: true }).click(); await expectStep(page, "确认计划"); await page.getByRole("button", { name: "确认改期", exact: true }).click(); await expectStep(page, "自动执行");
  assert.equal(latestPlan.revision, beforeReschedule.revision + 1); assert.equal(latestPlan.confirmedAt, beforeReschedule.confirmedAt); assert.equal(latestPlan.rule.weeklySlots.find(slot => slot.weekday === 3).time, "22:00");
  assert.deepEqual(firstJobs.map(job => job.spec.id), firstJobIds); assert.equal(view.jobs.length, 97); assert.deepEqual(uploadFacts(firstJobs), immutableUploads); assert.equal(firstJobs[2].spec.desired, "pause");
  for (const fixed of fixedJobs) assert.equal(firstJobs.find(job => job.spec.id === fixed.id).spec.originalPublishAt, fixed.time);
  assert.equal(firstJobs.some(job => job.spec.scheduleSource === "auto" && job.spec.originalPublishAt !== beforeReschedule.items.find(item => item.packageId === job.spec.contentPackage.id).publishAt), true); assert.equal(actions.filter(action => action === "plan-confirm").length, 1);
  console.log("Publishing smoke: confirmed reschedule preserved jobs, upload identity and fixed times.");
  assert.equal(await page.locator(".publishing-execution-details").getAttribute("open"), null);
  await page.getByText("任务与操作", { exact: true }).click(); await page.getByRole("button", { name: "暂停", exact: true }).first().click(); await page.getByText("暂停待设备确认", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).first().click(); await page.getByRole("button", { name: "取消任务", exact: true }).first().click(); await page.getByRole("button", { name: "确认取消", exact: true }).click(); await page.getByText("取消待设备确认", { exact: true }).waitFor();
  await page.getByText("任务与操作", { exact: true }).click();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "execution-" + width + ".png"); }
  await page.getByRole("button", { name: "发布下一批", exact: true }).click(); await page.getByRole("button", { name: "检测素材", exact: true }).click();
  await page.getByRole("radio", { name: /2030-10-Batch-02/ }).check(); await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("button", { name: "生成排期", exact: true }).click();
  await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor(); assert.equal(latestPlan.items.filter(item => !item.excluded).length, 100);
  await stepButton(page, "准备素材").click(); await expectStep(page, "准备素材"); await page.getByRole("radio", { name: /2030-10-Batch-01/ }).check();
  assert.equal(await stepButton(page, "设置时间").isDisabled(), true); assert.equal(await stepButton(page, "确认计划").isDisabled(), true);
  await page.getByRole("radio", { name: /2030-10-Batch-02/ }).check(); assert.equal(await stepButton(page, "确认计划").isDisabled(), true);
  await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("button", { name: "生成排期", exact: true }).click(); await expectStep(page, "确认计划");
  await page.getByRole("checkbox", { name: /^确认频道、内容和时间/ }).check(); await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).click(); await page.getByRole("heading", { name: "自动执行", exact: true }).waitFor();
  assert.equal(view.jobs.filter(job => job.spec.batchId === latestPlan.id).length, 100);
  const archivePlanId = latestPlan.id; for (const job of view.jobs.filter(value => value.spec.batchId === archivePlanId)) { job.observed.state = "scheduled"; job.observed.revision = job.spec.revision; }
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).isDisabled(), true);
  for (const job of view.jobs.filter(value => value.spec.batchId === archivePlanId)) { job.observed.state = "published"; job.observed.observedPrivacy = "public"; }
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await page.locator("button:not([disabled])").filter({ hasText: /^归档批次$/ }).waitFor(); assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).isDisabled(), false);
  // 已公开是持久完成事实，API缓存字段过期不能让批次永久失去归档入口。
  for (const job of view.jobs.filter(value => value.spec.batchId === archivePlanId)) { delete job.observed.observedPrivacy; delete job.observed.videoId; delete job.observed.remoteCheckedAt; }
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await page.getByRole("button", { name: "归档批次", exact: true }).click(); await page.getByText("归档待设备确认", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "核对归档", exact: true }).isDisabled(), false); await page.getByRole("button", { name: "核对归档", exact: true }).click(); assert.deepEqual(archiveRequests, [archivePlanId, archivePlanId]);
  // 另一台客户设备的任务已经到时，仍需远端公开证据；跨频道总览应展示它而非误记成功。
  const secondProfile = { ...structuredClone(profile), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agentId: "pc_two", accountId: accountTwo, channelId: "channel_two" };
  const secondPlan = { ...structuredClone(latestPlan), id: crypto.randomUUID(), profile: secondProfile, batch: { ...structuredClone(batches[1]), name: "2030-10-Channel-02", packages: [structuredClone(batches[1].packages[0])] }, items: [structuredClone(latestPlan.items[0])], archivePending: false };
  const secondJob = structuredClone(view.jobs.find(job => job.spec.batchId === archivePlanId)); secondJob.spec.id = crypto.randomUUID(); secondJob.spec.batchId = secondPlan.id; secondJob.spec.profile = secondProfile;
  secondJob.observed = { ...secondJob.observed, id: secondJob.spec.id, revision: secondJob.spec.revision, state: "scheduled", observedPrivacy: "private", effectivePublishAt: new Date(Date.now() - 60000).toISOString() };
  view.profiles.push(secondProfile); view.plans.push(secondPlan); view.jobs.push(secondJob);
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await page.getByRole("button", { name: "我的发布", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "总览", exact: true }).getAttribute("aria-pressed"), "true");
  const secondBatch = page.locator('[aria-label="批次 2030-10-Channel-02"]'); await secondBatch.waitFor(); await secondBatch.getByText("已公开 0", { exact: true }).waitFor(); await secondBatch.getByText("待发布 1", { exact: true }).waitFor(); await secondBatch.getByText(/^待核对 /).waitFor();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "overview-" + width + ".png"); }
  await page.getByLabel("发布频道", { exact: true }).selectOption("channel_two"); assert.equal(await page.locator('[aria-label="批次 2030-10-Batch-01"]').count(), 0); await secondBatch.waitFor();
  await secondBatch.getByRole("button", { name: "查看详情", exact: true }).click(); await page.getByRole("button", { name: "返回总览", exact: true }).click(); await secondBatch.waitFor();
  await page.getByLabel("发布频道", { exact: true }).selectOption(""); await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "下个月", exact: true }).click(); await page.getByRole("button", { name: "上个月", exact: true }).click(); await page.getByRole("button", { name: "今天", exact: true }).click();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "calendar-" + width + ".png"); }
  await page.getByRole("button", { name: "历史", exact: true }).click(); await page.getByLabel("搜索发布历史", { exact: true }).fill("2030-10-Batch-02"); await page.getByLabel("发布结果", { exact: true }).selectOption("published"); await page.getByText("100 条记录", { exact: true }).waitFor();
  const historyTable = page.getByRole("table", { name: "发布历史记录", exact: true }); const historyNames = [];
  for (let historyPage = 0; historyPage < 4; historyPage++) {
    assert.equal(await historyTable.locator("tbody > tr").count(), 25); historyNames.push(...await historyTable.getByRole("button", { name: /^查看.*详情$/ }).evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))));
    if (historyPage < 3) await page.getByRole("button", { name: "下一页", exact: true }).click();
  }
  assert.equal(historyNames.length, 100); assert.equal(new Set(historyNames).size, 100); assert.equal(await page.getByRole("button", { name: "下一页", exact: true }).isDisabled(), true);
  for (let historyPage = 0; historyPage < 3; historyPage++) await page.getByRole("button", { name: "上一页", exact: true }).click();
  await historyTable.getByRole("button", { name: /^查看.*详情$/ }).first().click(); const firstHistoryDetail = await page.locator('[id^="history-detail-"]').getAttribute("id"); assert.equal(await page.locator('[id^="history-detail-"]').count(), 1);
  await historyTable.getByRole("button", { name: /^查看.*详情$/ }).first().click(); assert.equal(await page.locator('[id^="history-detail-"]').count(), 1); assert.notEqual(await page.locator('[id^="history-detail-"]').getAttribute("id"), firstHistoryDetail);
  await page.getByLabel("搜索发布历史", { exact: true }).fill("100"); await page.getByText("1 条记录", { exact: true }).waitFor(); assert.equal(await historyTable.locator("tbody > tr").count(), 1); await historyTable.getByRole("button", { name: "查看100详情", exact: true }).waitFor();
  await page.getByLabel("搜索发布历史", { exact: true }).fill("没有这条发布记录"); await page.getByRole("heading", { name: "没有匹配的记录", exact: true }).waitFor(); await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByLabel("发布结果", { exact: true }).selectOption("failed"); await page.getByText("1 条记录", { exact: true }).waitFor(); await historyTable.getByText("失败", { exact: true }).waitFor();
  await page.getByLabel("发布结果", { exact: true }).selectOption("published"); await page.getByLabel("搜索发布历史", { exact: true }).fill("2030-10-Batch-02"); await page.getByText("100 条记录", { exact: true }).waitFor(); assert.equal(await page.locator('[id^="history-detail-"]').count(), 0);
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "history-" + width + ".png"); }
  console.log("Publishing smoke: 100 history records, search, filters and one detail passed.");
  await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("button", { name: "发布账号", exact: true }).click(); await page.getByText("授权与数据 · Rainy Night Radio", { exact: true }).click(); await page.getByRole("button", { name: "撤销授权与删除数据", exact: true }).click(); await page.getByRole("button", { name: "确认撤销与删除", exact: true }).click(); await page.getByText(/等待设备清理，期限/).waitFor();
  assert.equal(await page.getByText("授权撤销与设备清理已确认", { exact: true }).count(), 0);
  assert.equal(view.jobs.filter(job => job.spec.profile.accountId === accountTwo).length, 1); assert.equal(view.accounts.find(account => account.id === accountTwo).status, "connected"); assert.equal(view.accounts.find(account => account.id === accountThree).status, "connected");
  await page.getByRole("button", { name: "添加账号", exact: true }).click(); await page.waitForURL(url => url.searchParams.get("synthetic-account") === "44444444-4444-4444-8444-444444444444"); await page.getByLabel("发布账号", { exact: true }).waitFor(); await page.getByLabel("设备", { exact: true }).selectOption("pc:main");
  assert.deepEqual(accountConnectRequests, [createdAccount.id]); assert.equal(createdAccount.status, "unbound"); assert.equal(await page.getByLabel("发布账号", { exact: true }).locator('option[value="' + createdAccount.id + '"]').count(), 1);
  assert.deepEqual(legacyRequests, []); assert.equal(actions.includes("cleanup"), false);
  // 授权结果回到原设备/账号，不能被另一设备的更新草稿或默认设备覆盖。
  const newerDraft = { ...structuredClone(latestPlan), id: crypto.randomUUID(), profile: structuredClone(thirdProfile), createdAt: Date.now() + 1000 }; delete newerDraft.confirmedAt; delete newerDraft.archivedAt; delete newerDraft.archivePending; view.plans.push(newerDraft);
  const callbackPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); callbackPage.on("pageerror", error => errors.push(error.message)); await callbackPage.route("**/api/**", mock);
  await callbackPage.goto(origin + "/publishing?oauthResult=55555555-5555-4555-8555-555555555555"); await callbackPage.getByText("发布账号已连接", { exact: true }).waitFor(); await expectStep(callbackPage, "准备素材");
  assert.equal(await callbackPage.getByLabel("设备", { exact: true }).inputValue(), "pc_two:main"); assert.equal(await callbackPage.getByLabel("发布账号", { exact: true }).inputValue(), accountTwo); assert.deepEqual(oauthResultRequests, ["55555555-5555-4555-8555-555555555555"]); await callbackPage.close();
  await page.goto(origin + "/privacy"); await page.getByRole("heading", { name: "LiveNest 隐私政策" }).waitFor(); await page.goto(origin + "/terms"); await page.getByRole("heading", { name: "LiveNest 服务条款" }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, mockedApi: true, realUploads: false, packageCount: 100, steps: 4, covered: ["independent-account-selection", "same-device-account-draft-isolation", "independent-account-playlists", "account-scoped-cleanup", "account-create-synthetic-connect", "oauth-result-original-account", "no-shared-live-auth-requests", "step-button-keyboard", "step-touch-targets", "step-draft-preservation", "step-invalid-package-guard", "step-manual-override-preservation", "step-unsaved-edit-preservation", "step-changed-batch-guard", "confirmed-step-navigation", "confirmed-materials-readonly", "confirmed-rules-draft-reload", "confirmed-return-execution-without-save", "confirmed-schedule-preview-confirm", "reschedule-same-jobs-upload-facts", "reschedule-manual-terminal-fixed", "reschedule-paused-intent-preserved", "history-100-record-pagination", "history-full-search", "history-result-filter", "history-single-detail", "default-plan-calendar", "plan-calendar-months", "plan-calendar-local-date", "plan-list-pagination", "cross-channel-overview", "overview-channel-filter", "overview-past-scheduled-not-published", "overview-batch-details", "package-errors", "explicit-exclusion", "device-draft-isolation", "per-weekday-time", "same-day-slots", "occupied-slots", "manual-override", "cloud-draft-reload", "unicode-title", "100-job-confirm", "pause-cancel-pending", "archive-persistent-completion", "archive-expired-api-fields", "archive-pending-reconcile", "permission-navigation"], actions, screenshots, viewportWidths: [1440, 1024, 390, 320] }, null, 2)); console.log("Publishing browser smoke passed (100 packages, four steps, mock API; no real upload).");
} finally { await browser.close(); }
