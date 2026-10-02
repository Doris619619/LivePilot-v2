/** 四步发布浏览器验收：模拟100个本地发布包和Cloud响应，不连接真实Agent、OBS或YouTube。 */
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
const profile = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, name: "常规发布", agentId: "pc", instanceId: "main", channelId: "channel_one", titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", playlistIds: [], privacy: "public", scheduled: true, madeForKids: false, license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "matching", ai: { enabled: false, language: "English", prompt: "Generate accurate copy", fallbackTitle: "{{packageName}}", fallbackDescription: "" }, schedule: { timezone: "UTC", weekdays: [1, 3, 5, 7], localTime: "18:00", startDate: "2030-10-01", preuploadDays: 28 } };
const view = { profiles: [profile], jobs: [], plans: [], cleanups: [], policy, administrator: false };
let confirmed; let latestPlan; const errors = []; const actions = []; const screenshots = []; const archiveRequests = [];
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
/** 所有API限定为预设模拟端点，未声明请求直接使验收失败。 */
async function mock(route) {
  const url = new URL(route.request().url()); const body = route.request().postDataJSON(); let result;
  if (url.pathname === "/api/session") result = { user: { username: "alice", role: "customer" } };
  else if (url.pathname === "/api/instances") result = { instances: [{ id: "main", name: "音乐频道", agentId: "pc", agentName: "工作室电脑" }, { id: "main", name: "第二频道", agentId: "pc_two", agentName: "另一台电脑" }] };
  else if (url.pathname === "/api/broadcast-assets") result = { playlists: [{ id: "PLsynthetic", title: "Rainy Night Sessions" }] };
  else if (url.pathname === "/api/publishing") {
    if (!body) result = view;
    else {
      actions.push(body.action);
      if (body.action === "consent") { view.consent = { version: body.version }; result = { ok: true }; }
      if (body.action === "packages") result = { root: body.agentId === "pc" ? "D:\\LIVENEST\\Publishing" : "E:\\LiveNest\\Publishing", batches: body.agentId === "pc" ? batches : [batches[1]], thumbnails: [], channelId: "channel_one", channel: "Rainy Night Radio" };
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
      if (body.action === "job") {
        const job = view.jobs.find(value => value.spec.id === body.id); job.spec.desired = body.operation === "pause" ? "pause" : body.operation === "resume" ? "run" : body.operation === "cancel" ? "cancel" : "run"; job.spec.revision++;
        if (body.operation === "resume") job.observed.revision = job.spec.revision; result = job;
      }
      if (body.action === "plan-archive") { archiveRequests.push(body.planId); const plan = view.plans.find(value => value.id === body.planId); plan.archivePending = true; result = { state: "pending" }; }
      if (body.action === "cleanup") { view.jobs = []; view.profiles = []; view.plans = []; view.cleanups = [{ id: "cleanup", agentId: "pc", instanceId: "main", deadline: Date.now() + 7 * 86400000, state: "pending" }]; result = view.cleanups[0]; }
    }
  }
  assert.ok(result, "Unexpected mocked request: " + url.pathname); await route.fulfill({ json: result });
}
/** 截图前清除焦点并检查整体没有横向溢出。 */
async function capture(page, name) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
  const overflowing = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== "absolute").map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })).slice(0, 20));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Overflow in " + name + ": " + JSON.stringify(overflowing));
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", error => errors.push(error.message)); await page.route("**/api/**", mock);
  await page.goto(origin + "/publishing"); await page.getByRole("heading", { name: "准备素材", exact: true }).waitFor();
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
  await page.getByLabel("是否专为儿童制作").selectOption("false"); await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByRole("heading", { name: "设置时间", exact: true }).waitFor(); await page.getByLabel("开始日期", { exact: true }).fill("2030-10-01"); await page.getByLabel("时区", { exact: true }).fill("UTC");
  await page.getByLabel("周一发布时间", { exact: true }).fill("18:00"); await page.getByLabel("周三发布时间", { exact: true }).fill("20:00"); await page.getByLabel("周五发布时间", { exact: true }).fill("18:00"); await page.getByLabel("周日发布时间", { exact: true }).fill("12:00");
  await page.getByRole("button", { name: "周一添加时间", exact: true }).click(); assert.equal(await page.getByLabel("周一发布时间 2", { exact: true }).count(), 1); await page.getByRole("button", { name: "删除周一时间 2", exact: true }).click();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "schedule-" + width + ".png"); }
  await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.equal(latestPlan.items.filter(item => !item.excluded).length, 98); assert.equal(latestPlan.skippedOccupied, 6); assert.equal(latestPlan.rule.weeklySlots.find(slot => slot.weekday === 3).time, "20:00");
  assert.equal(await page.locator(".publishing-plan-item").count(), 25); await page.getByRole("button", { name: "编辑发布包 001", exact: true }).click();
  const title = page.getByLabel("标题", { exact: true }); await title.fill("🌙".repeat(101)); assert.equal(await page.getByRole("button", { name: "保存修改", exact: true }).isDisabled(), true);
  await title.fill("🌙".repeat(100)); assert.equal(await title.getAttribute("maxlength"), null); assert.equal(await page.getByRole("button", { name: "保存修改", exact: true }).isDisabled(), false);
  await title.fill("东京雨夜 · Tokyo Rainy Night"); await page.getByLabel("发布时间 · UTC", { exact: true }).fill("2030-10-10T14:30"); await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByText("手动", { exact: true }).waitFor(); const manualAt = latestPlan.items.find(item => item.packageId === batches[0].packages[0].id).publishAt;
  await page.reload(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor(); await page.getByText("手动", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回设置", exact: true }).click(); await page.getByLabel("周三发布时间", { exact: true }).fill("21:00"); await page.getByRole("button", { name: "生成排期", exact: true }).click(); await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor();
  assert.equal(latestPlan.items.find(item => item.packageId === batches[0].packages[0].id).publishAt, manualAt); assert.equal(actions.filter(action => action === "plan-preview").length, 1);
  await page.getByRole("button", { name: "编辑发布包 002", exact: true }).click(); await page.getByRole("checkbox", { name: "暂不发布", exact: true }).check(); await page.getByRole("button", { name: "保存修改", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).isDisabled(), true); await page.getByRole("checkbox", { name: /^确认频道、内容和时间/ }).check();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "confirmation-" + width + ".png"); }
  await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).click(); await page.getByRole("heading", { name: "自动执行", exact: true }).waitFor();
  assert.equal(confirmed.revision, latestPlan.revision); assert.equal(view.jobs.length, 97); assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).isDisabled(), true);
  assert.equal(await page.locator(".publishing-execution-details").getAttribute("open"), null);
  await page.getByText("任务与操作", { exact: true }).click(); await page.getByRole("button", { name: "暂停", exact: true }).first().click(); await page.getByText("暂停待设备确认", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).first().click(); await page.getByRole("button", { name: "取消任务", exact: true }).first().click(); await page.getByRole("button", { name: "确认取消", exact: true }).click(); await page.getByText("取消待设备确认", { exact: true }).waitFor();
  await page.getByText("任务与操作", { exact: true }).click();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "execution-" + width + ".png"); }
  await page.getByRole("button", { name: "发布下一批", exact: true }).click(); await page.getByRole("button", { name: "检测素材", exact: true }).click();
  await page.getByRole("radio", { name: /2030-10-Batch-02/ }).check(); await page.getByRole("button", { name: "下一步", exact: true }).click(); await page.getByRole("button", { name: "生成排期", exact: true }).click();
  await page.getByRole("heading", { name: "确认计划", exact: true }).waitFor(); assert.equal(latestPlan.items.filter(item => !item.excluded).length, 100);
  await page.getByRole("checkbox", { name: /^确认频道、内容和时间/ }).check(); await page.getByRole("button", { name: "确认上传并按计划发布", exact: true }).click(); await page.getByRole("heading", { name: "自动执行", exact: true }).waitFor();
  assert.equal(view.jobs.filter(job => job.spec.batchId === latestPlan.id).length, 100);
  const archivePlanId = latestPlan.id; for (const job of view.jobs.filter(value => value.spec.batchId === archivePlanId)) { job.observed.state = "published"; job.observed.revision = job.spec.revision; }
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); assert.equal(await page.getByRole("button", { name: "归档批次", exact: true }).isDisabled(), true);
  for (const job of view.jobs.filter(value => value.spec.batchId === archivePlanId)) job.observed.observedPrivacy = "public";
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await page.getByRole("button", { name: "归档批次", exact: true }).click(); await page.getByText("归档待设备确认", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "核对归档", exact: true }).isDisabled(), false); await page.getByRole("button", { name: "核对归档", exact: true }).click(); assert.deepEqual(archiveRequests, [archivePlanId, archivePlanId]);
  await page.getByRole("button", { name: "我的发布", exact: true }).click(); await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "下个月", exact: true }).click(); await page.getByRole("button", { name: "上个月", exact: true }).click(); await page.getByRole("button", { name: "今天", exact: true }).click();
  for (const width of [320, 390, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "calendar-" + width + ".png"); }
  await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("button", { name: "授权与数据", exact: true }).click(); await page.getByRole("button", { name: "撤销授权与删除数据", exact: true }).click(); await page.getByRole("button", { name: "确认撤销与删除", exact: true }).click(); await page.getByText(/等待设备清理，期限/).waitFor();
  assert.equal(await page.getByText("授权撤销与设备清理已确认", { exact: true }).count(), 0);
  await page.goto(origin + "/privacy"); await page.getByRole("heading", { name: "LiveNest 隐私政策" }).waitFor(); await page.goto(origin + "/terms"); await page.getByRole("heading", { name: "LiveNest 服务条款" }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, mockedApi: true, realUploads: false, packageCount: 100, steps: 4, covered: ["package-errors", "explicit-exclusion", "device-draft-isolation", "per-weekday-time", "same-day-slots", "occupied-slots", "manual-override", "cloud-draft-reload", "unicode-title", "100-job-confirm", "pause-cancel-pending", "archive-public-proof", "archive-pending-reconcile", "permission-navigation"], actions, screenshots, viewportWidths: [1440, 1024, 390, 320] }, null, 2)); console.log("Publishing browser smoke passed (100 packages, four steps, mock API; no real upload).");
} finally { await browser.close(); }
