/** 发布账号连接与三种单账号布局回归：真实浏览器与组件使用合成 API，禁止访问真实 Agent、OAuth 或 YouTube。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "livepilot-account-connection-ui-"));
const initialId = "11111111-1111-4111-8111-111111111111";
const createdId = "22222222-2222-4222-8222-222222222222";
const oauthResultId = "99999999-9999-4999-8999-999999999999";
const offlineMessage = "设备离线，请打开这台电脑的 LiveNest，待设备上线后再连接频道。";
const rejectedMessage = "设备已离线，连接频道失败，请打开这台电脑的 LiveNest 后重试。";
const view = createPublishingPreview().view;
Object.assign(view, { profiles: [], templates: [], jobs: [], plans: [], cleanups: [], administrator: false, accounts: [{ id: initialId, agentId: "synthetic_pc", instanceId: "main", name: "原有账号", owner: "tester", status: "unbound", createdAt: 1, updatedAt: 1 }] });
const requests = [];
const pageErrors = [];
const externalRequests = [];
let online = true;
let reads = 0;
let oauthResultReads = 0;
let connectionSucceeds = false;
const screenshotDirectory = process.env.LIVEPILOT_ACCOUNT_UI_SCREENSHOTS && path.resolve(process.env.LIVEPILOT_ACCOUNT_UI_SCREENSHOTS);
const entry = `import React from "react"; import {createRoot} from "react-dom/client"; import "./src/app/globals.css"; import "./src/app/components/ui/ui.css"; import PublishingConsole from "./src/app/publishing/publishing-console";
/** 只改变真实组件的布局属性，切换布局时保留账号选择与连接错误。 */
function Harness() { const [layout, setLayout] = React.useState(); React.useEffect(() => { window.setLayout = setLayout; return () => { delete window.setLayout; }; }, []); return <PublishingConsole accountsLayout={layout}/>; }
createRoot(document.getElementById("root")).render(<Harness/>);`;
await build({ stdin: { contents: entry, resolveDir: repo, loader: "tsx" }, outfile: path.join(directory, "probe.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": path.join(repo, "src") }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "silent" });
const javascript = await readFile(path.join(directory, "probe.js"));
const css = await readFile(path.join(directory, "probe.css"));
/** 只提供本次编译的静态组件；所有 API 由浏览器白名单拦截。 */
const server = http.createServer((request, response) => {
  if (request.url === "/probe.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
  else if (request.url === "/probe.css") { response.setHeader("content-type", "text/css"); response.end(css); }
  else if (request.url?.startsWith("/synthetic-avatar-")) { response.setHeader("content-type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#315efb"/></svg>'); }
  else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/probe.css"><p style="padding:8px 16px;background:#edf2fe;color:#536174;font:13px system-ui">合成测试数据 · 未连接真实设备或 Google</p><div id="root"></div><script src="/probe.js"></script>'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  /** 仅合成 OAuth 导航可返回本地构造页面；其他外域请求阻断，绝不实际请求 Google。 */
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) {
      externalRequests.push({ origin: url.origin, pathname: url.pathname });
      if (connectionSucceeds && request.isNavigationRequest() && url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth") return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><meta charset=\"utf-8\"><h1>合成Google授权页</h1>" });
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    let result;
    if (url.pathname === "/api/session") result = { user: { username: "tester", role: "customer" } };
    else if (url.pathname === "/api/instances") result = { agents: online === undefined ? undefined : [{ id: "synthetic_pc", online }], instances: [{ id: "main", name: "OBS 1", agentId: "synthetic_pc", agentName: "合成测试电脑" }] };
    else if (url.pathname === "/api/youtube/result") { assert.equal(url.searchParams.get("id"), oauthResultId); oauthResultReads++; result = { target: { agentId: "synthetic_pc", instanceId: "main" }, accountId: createdId, status: "connected" }; }
    else if (url.pathname === "/api/publishing" && request.method() === "GET") { reads++; result = view; }
    else if (url.pathname === "/api/publishing") {
      const body = request.postDataJSON();
      if (body.action === "packages") result = { root: "D:\\Synthetic\\Publishing", batches: [], thumbnails: [] };
      else if (body.action === "account-create") {
        requests.push(body);
        assert.equal(view.accounts.some(account => account.id === createdId), false, "Retry must not create a second account");
        result = { id: createdId, agentId: body.agentId, instanceId: body.instanceId, name: body.name, owner: "tester", status: "unbound", createdAt: 2, updatedAt: 2 }; view.accounts.push(result);
      } else if (body.action === "account-connect") {
        requests.push(body);
        if (connectionSucceeds) return route.fulfill({ json: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client&state=synthetic-state" } });
        const message = body.accountId === createdId ? rejectedMessage : "原有账号的合成连接失败";
        return route.fulfill({ status: 503, json: { error: message, problem: { version: 1, source: "cloud", code: "AGENT_OFFLINE", domain: "device", target: {}, severity: "error", stage: "连接发布账号", outcome: "rejected", observedAt: 1, message, actions: ["refresh"] } } });
      }
    }
    assert.ok(result, "Unexpected synthetic endpoint: " + url.pathname);
    return route.fulfill({ json: result });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on("pageerror", error => pageErrors.push(error.message));
  const manager = page.locator('.account-manager[aria-label="发布账号管理"]');
  /** 通过可见账号导航选择目标，并确认只挂载该账号的详情，避免旧账号数据与操作混入。 */
  async function selectAccount(name, label = name) {
    const button = manager.getByRole("button", { name: "选择账号 " + label, exact: true });
    await button.click();
    const detail = page.getByRole("region", { name: "发布账号 " + name, exact: true });
    await detail.waitFor();
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("region", { name: /^发布账号 / }).count(), 1);
    return detail;
  }
  /** 等待真实连接流程收尾，再统计请求或判断按钮恢复，避免只等到错误渲染就读取中间态。 */
  async function waitForAccountActions() {
    await page.waitForFunction(() => document.querySelector('[aria-label="发布账号管理"]')?.getAttribute("aria-busy") === "false");
  }
  /** 精简后的账号管理不重复显示法律链接、Google入口或设备/账号元数据，也不嵌套交互按钮。 */
  async function assertReducedAccountManager() {
    assert.equal(await manager.locator('a[href="https://security.google.com/settings/security/permissions"], a[href="/privacy"], a[href="/terms"]').count(), 0);
    assert.equal(await manager.locator(".account-manager-metadata, time").count(), 0);
    assert.equal(await manager.getByText(/^(发布设备|账号名称|添加日期)$/).count(), 0);
    assert.equal(await manager.locator("button button").count(), 0);
    assert.equal(await manager.locator(".account-manager-data").count(), 0);
  }
  /** 正式弹窗样式必须固定覆盖视口；桌面与窄屏均保留可见边界，不能被账号布局裁切。 */
  async function assertDialogBounds(dialog) {
    const bounds = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { position: getComputedStyle(element).position, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.equal(bounds.position, "fixed");
    assert.ok(bounds.left >= -1 && bounds.top >= -1 && bounds.right <= bounds.viewportWidth + 1 && bounds.bottom <= bounds.viewportHeight + 1, "Dialog must remain inside the current viewport: " + JSON.stringify(bounds));
  }
  /** 删除入口打开可访问模态，隔离背景、锁定焦点并展示目标账号与远端保留边界，不提交清理请求。 */
  async function openDeleteConfirmation(label, authorized) {
    const trigger = manager.getByRole("button", { name: "删除账号 " + label, exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "删除发布账号？", exact: true }).waitFor();
    await assertDialogBounds(dialog);
    assert.equal(await page.getByRole("dialog", { name: "删除发布账号？", exact: true }).count(), 1);
    assert.equal(await manager.evaluate(element => !!element.closest('[aria-hidden="true"], [inert]')), true, "Modal must hide the background from assistive navigation");
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    for (const key of ["Shift+Tab", "Tab", "Tab", "Tab", "Tab"]) {
      await page.keyboard.press(key);
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, "Keyboard focus must stay inside the deletion dialog");
    }
    assert.ok((await dialog.innerText()).includes(label), "Deletion confirmation must identify the requested account");
    await dialog.getByRole("button", { name: authorized ? "确认撤销并删除" : "确认删除账号", exact: true }).waitFor();
    await dialog.getByText(/已提交的定时视频仍可能公开/).waitFor();
    await dialog.getByText(/本地源文件和 YouTube 视频保留/).waitFor();
    if (authorized) await dialog.getByText(/同一 Google 用户的直播和其他频道也可能需要重新连接/).waitFor();
    assert.equal(await dialog.getByRole("link").count(), 0);
    return { dialog, trigger };
  }
  /** 取消或 Escape 都必须关闭模态并归还焦点，不能触发账号清理。 */
  async function dismissDeletion({ dialog, trigger }, escape = false) {
    if (escape) await dialog.press("Escape");
    else await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // Radix FocusScope 在卸载后的零延时回调归还焦点；推进测试时钟执行它，不把调度中间态判为失败。
    await page.clock.runFor(1);
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    assert.equal(requests.some(request => request.action === "account-cleanup"), false);
  }
  await page.clock.install();
  await page.goto(origin + "/publishing");
  await page.getByRole("button", { name: "发布账号", exact: true }).click();
  await page.locator(".account-manager--compact").waitFor();
  await assertReducedAccountManager();
  assert.equal(await page.getByRole("combobox", { name: "发布账号", exact: true }).count(), 0, "Desktop management uses account navigation instead of a second visible picker");
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).count(), 1);
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "连接 YouTube 频道", exact: true });
  await addDialog.getByRole("heading", { name: "连接 YouTube 频道", exact: true }).waitFor();
  await assertDialogBounds(addDialog);
  assert.equal(requests.filter(request => request.action === "account-create").length, 0, "Opening account information must not create an empty account");
  await addDialog.getByRole("button", { name: "取消", exact: true }).click();
  await addDialog.waitFor({ state: "hidden" });
  assert.equal(requests.filter(request => request.action === "account-create").length, 0);
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await addDialog.getByRole("button", { name: "连接频道", exact: true }).click();
  await addDialog.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  await addDialog.getByRole("button", { name: "重试连接频道", exact: true }).click();
  await waitForAccountActions();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  assert.equal(requests.filter(request => request.action === "account-connect" && request.accountId === createdId).length, 2);
  await addDialog.getByRole("button", { name: "取消", exact: true }).click();
  await addDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "选择账号 发布账号 2", exact: true, pressed: true }).waitFor();
  await page.getByText(rejectedMessage, { exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  process.stdout.write("PASS: Add first opens information without mutation; confirmation creates once, modal retry reuses that account and closing preserves its error.\n");

  const createdRow = page.getByRole("region", { name: "发布账号 发布账号 2", exact: true });
  await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  await createdRow.getByRole("button", { name: "重试连接频道", exact: true }).click();
  await waitForAccountActions();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  assert.equal(requests.filter(request => request.action === "account-connect" && request.accountId === createdId).length, 3);
  const readsBefore = reads;
  const refreshed = page.waitForResponse(response => response.url() === origin + "/api/publishing" && response.request().method() === "GET");
  await page.clock.runFor(11000);
  await refreshed;
  assert.ok(reads > readsBefore);
  await createdRow.getByText(rejectedMessage, { exact: true }).waitFor();
  process.stdout.write("PASS: retry uses the same account and background refresh preserves the failure.\n");

  for (const layout of ["split", "grid", "compact"]) {
    await page.evaluate(value => window.setLayout(value), layout);
    await page.locator(".account-manager--" + layout).waitFor();
    await assertReducedAccountManager();
    await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: /^发布账号 / }).count(), 1);
    assert.equal(await page.getByRole("combobox", { name: "发布账号", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).count(), 1);
    await selectAccount("原有账号");
    assert.equal(await createdRow.count(), 0);
    await selectAccount("发布账号 2");
    await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    const mobilePicker = page.getByRole("combobox", { name: "发布账号", exact: true });
    await mobilePicker.waitFor();
    assert.equal(await mobilePicker.inputValue(), createdId);
    assert.equal(await page.getByRole("button", { name: /^选择账号 / }).count(), 0);
    await mobilePicker.selectOption(initialId);
    await page.getByRole("region", { name: "发布账号 原有账号", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: /^发布账号 / }).count(), 1);
    await mobilePicker.selectOption(createdId);
    await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
    await dismissDeletion(await openDeleteConfirmation("发布账号 2", false));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, layout + " must fit 390px without horizontal overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "选择账号 发布账号 2", exact: true, pressed: true }).waitFor();
  }
  process.stdout.write("PASS: split, grid and compact layouts retain selection and errors with one detail, desktop navigation and a 390px account picker.\n");

  const initialRow = await selectAccount("原有账号");
  await initialRow.getByRole("button", { name: "连接频道", exact: true }).click();
  await initialRow.getByRole("alert").getByText("原有账号的合成连接失败", { exact: true }).waitFor();
  await selectAccount("发布账号 2");
  await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  assert.equal(await createdRow.getByText("原有账号的合成连接失败", { exact: true }).count(), 0);
  await selectAccount("原有账号");
  await page.getByRole("button", { name: "发布视频", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "发布账号", exact: true }).inputValue(), initialId);
  await page.getByRole("alert").getByText("原有账号的合成连接失败", { exact: true }).waitFor();
  assert.equal(await page.getByText(rejectedMessage, { exact: true }).isVisible().catch(() => false), false);
  process.stdout.write("PASS: another account's connection failure stays attached to its row and selection.\n");

  online = false;
  await page.getByRole("button", { name: "发布账号", exact: true }).click();
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.getByText(offlineMessage, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).isDisabled(), true);
  assert.equal(await initialRow.getByRole("button", { name: "重试连接频道", exact: true }).isDisabled(), true);
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  online = true;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && !button.disabled));
  assert.equal(await initialRow.getByRole("button", { name: "重试连接频道", exact: true }).isEnabled(), true);
  online = false;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && button.disabled));
  online = undefined;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && !button.disabled));
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).isEnabled(), true);
  assert.equal(await initialRow.getByRole("button", { name: "重试连接频道", exact: true }).isEnabled(), true);
  assert.equal(await page.getByText(offlineMessage, { exact: true }).count(), 0);
  process.stdout.write("PASS: unknown device status remains actionable instead of being treated as offline.\n");

  online = true; view.accounts = [];
  await page.reload();
  await page.getByRole("heading", { name: "发布视频", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await addDialog.getByRole("heading", { name: "连接 YouTube 频道", exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  await addDialog.getByRole("button", { name: "连接频道", exact: true }).click();
  await addDialog.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  await addDialog.getByRole("button", { name: "取消", exact: true }).click();
  await addDialog.waitFor({ state: "hidden" });
  await page.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "发布账号", exact: true }).inputValue(), createdId);
  assert.equal(requests.filter(request => request.action === "account-create").length, 2);
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).count(), 0);
  const connectionCount = requests.filter(request => request.action === "account-connect").length;
  await page.getByRole("button", { name: "重试连接频道", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('select[aria-label="发布账号"]')?.disabled);
  assert.equal(requests.filter(request => request.action === "account-create").length, 2);
  assert.equal(requests.filter(request => request.action === "account-connect").length, connectionCount + 1);
  assert.equal(requests.at(-1).accountId, createdId);
  process.stdout.write("PASS: first-account creation from the video page keeps the failure and created account visible.\n");

  await page.getByRole("button", { name: "发布账号", exact: true }).click();
  const unboundDetail = await selectAccount("发布账号 1");
  await assertReducedAccountManager();
  assert.equal(await unboundDetail.getByRole("link", { name: "查看频道主页", exact: true }).count(), 0);
  await dismissDeletion(await openDeleteConfirmation("发布账号 1", false));
  process.stdout.write("PASS: compact is the default; account details omit duplicate metadata and links while trash opens accessible, cancellable confirmation.\n");

  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, "never-connected-desktop-synthetic.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole("button", { name: "导航", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(screenshotDirectory, "never-connected-390-synthetic.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "发布账号", exact: true }).waitFor();
  }

  const historyCases = [
    { name: "已连接账号", channel: "合成已连接频道", channelId: "synthetic_connected_channel", status: "connected", channelAvatarUrl: origin + "/synthetic-avatar-connected.svg" },
    { name: "需重新授权账号", channelId: "synthetic_reauthorize_channel", status: "needs_reauthorization", channelAvatarUrl: origin + "/synthetic-avatar-reauthorize.svg" },
    { name: "保留频道的账号", status: "unbound", channelId: "synthetic_old_channel" },
    { name: "保留连接时间的账号", status: "unbound", connectedAt: 10 },
  ];
  for (const [index, history] of historyCases.entries()) view.accounts.push({ ...view.accounts[0], ...history, id: String(index + 3).repeat(8) + "-1111-4111-8111-111111111111" });
  const cleanupCases = [{ name: "未连接账号待清理", status: "cleanup_pending" }, { name: "历史账号待清理", status: "cleanup_pending", channelId: "synthetic_cleanup_channel" }];
  for (const [index, pending] of cleanupCases.entries()) view.accounts.push({ ...view.accounts[0], ...pending, id: String(index + 7).repeat(8) + "-1111-4111-8111-111111111111" });
  const legacyProfile = { ...createPublishingPreview().view.profiles[0], agentId: "synthetic_pc", instanceId: "main" }; delete legacyProfile.accountId;
  view.profiles = [legacyProfile];
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  for (const identity of historyCases.filter(account => account.channelAvatarUrl)) {
    const detail = await selectAccount(identity.name, identity.channel || identity.name);
    const avatar = detail.locator('img[src="' + identity.channelAvatarUrl + '"]');
    await avatar.waitFor();
    await page.waitForFunction(url => [...document.images].some(element => element.src === url && element.complete && element.naturalWidth > 0), identity.channelAvatarUrl);
    assert.equal(await avatar.evaluate(element => element.complete && element.naturalWidth > 0), true);
    assert.equal(await manager.locator(".account-manager-detail img").count(), 1);
    const otherAvatar = historyCases.find(account => account.channelAvatarUrl && account.channelAvatarUrl !== identity.channelAvatarUrl).channelAvatarUrl;
    assert.equal(await manager.locator('img[src="' + otherAvatar + '"]').count(), 0);
    const channelLink = detail.getByRole("link", { name: "查看频道主页", exact: true });
    assert.equal(await channelLink.getAttribute("href"), "https://www.youtube.com/channel/" + encodeURIComponent(identity.channelId));
    assert.equal(await channelLink.getAttribute("target"), "_blank");
    assert.match(await channelLink.getAttribute("rel"), /\bnoreferrer\b/);
  }
  await selectAccount("发布账号 1");
  assert.equal(await unboundDetail.locator("img").count(), 0);
  process.stdout.write("PASS: selected account shows its own local synthetic avatar and channel-home link; never-connected accounts expose neither.\n");
  for (const [index, history] of historyCases.entries()) {
    await assertReducedAccountManager();
    const confirmation = await openDeleteConfirmation(history.channel || history.name, true);
    assert.equal(await manager.getByRole("button", { name: "选择账号 发布账号 1", exact: true, includeHidden: true }).getAttribute("aria-pressed"), "true", "Deleting another row must not replace the selected account");
    assert.equal(await manager.locator('[aria-label="发布账号 发布账号 1"]').count(), 1);
    assert.equal(await manager.locator(".account-manager-detail").count(), 1);
    await dismissDeletion(confirmation, index === 0);
  }
  process.stdout.write("PASS: non-selected account deletion targets its own authorization history; cancel and Escape preserve selection and restore trash-button focus.\n");
  for (const pending of cleanupCases) {
    const detail = await selectAccount(pending.name);
    await detail.getByText("等待设备完成清理，请保持 LiveNest 在线。", { exact: true }).waitFor();
    await assertReducedAccountManager();
    assert.equal(await detail.getByRole("button", { name: /连接频道|重新授权/ }).count(), 0, "Cleanup-pending details must not offer a connection action");
    assert.equal(await manager.getByRole("button", { name: "删除账号 " + pending.name, exact: true }).isDisabled(), true);
  }
  process.stdout.write("PASS: cleanup-pending accounts explain device cleanup without directing users to their disabled connection buttons.\n");
  const legacyData = page.locator("details").filter({ has: page.locator("summary").getByText("旧版任务授权", { exact: true }) });
  await legacyData.locator("summary").click();
  assert.equal(await legacyData.getByRole("link", { name: "查看或撤销 Google 授权", exact: true }).getAttribute("href"), "https://security.google.com/settings/security/permissions");
  await legacyData.getByText("此入口用于查看或撤销旧实例已有的 Google 授权。", { exact: true }).waitFor();
  assert.equal(await legacyData.getByText(/请使用上方的|重新连接请使用上方/).count(), 0);
  await legacyData.getByText("撤销旧实例的授权，并删除保存的 YouTube 数据。", { exact: true }).waitFor();
  process.stdout.write("PASS: authorized account deletion retains Google scope and scheduled-video consequences; legacy tasks retain their separate authorization management.\n");

  connectionSucceeds = true;
  const createsBeforeAuthorization = requests.filter(request => request.action === "account-create").length;
  const connectionsBeforeAuthorization = requests.filter(request => request.action === "account-connect").length;
  await page.evaluate(id => sessionStorage.setItem("livenest-publishing-account-add:tester", id), createdId);
  await selectAccount("发布账号 1");
  await unboundDetail.getByRole("button", { name: "重试连接频道", exact: true }).click();
  await page.getByRole("heading", { name: "合成Google授权页", exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, createsBeforeAuthorization);
  assert.equal(requests.filter(request => request.action === "account-connect").length, connectionsBeforeAuthorization + 1);
  assert.equal(requests.at(-1).accountId, createdId);
  assert.equal(new URL(page.url()).origin, "https://accounts.google.com");
  assert.equal(new URL(page.url()).pathname, "/o/oauth2/v2/auth");
  assert.deepEqual(externalRequests, [{ origin: "https://accounts.google.com", pathname: "/o/oauth2/v2/auth" }]);
  process.stdout.write("PASS: Connect channel reuses the selected account and opens only the intercepted synthetic OAuth consent page, never Google authorization management.\n");
  const returnedAccount = view.accounts.find(account => account.id === createdId);
  Object.assign(returnedAccount, { status: "connected", channelId: "synthetic_callback_channel", channel: "回调合成频道", channelAvatarUrl: origin + "/synthetic-avatar-callback.svg", connectedAt: 20 });
  await page.goto(origin + "/publishing?oauthResult=" + oauthResultId);
  await page.getByText("账号添加成功", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "发布账号", exact: true }).waitFor();
  await manager.getByRole("button", { name: "选择账号 回调合成频道", exact: true, pressed: true }).waitFor();
  await page.getByRole("region", { name: "发布账号 发布账号 1", exact: true }).locator('img[src="' + returnedAccount.channelAvatarUrl + '"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "发布账号 发布账号 1", exact: true }).getByRole("link", { name: "查看频道主页", exact: true }).getAttribute("href"), "https://www.youtube.com/channel/" + returnedAccount.channelId);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("livenest-publishing-account-add:tester")), null);
  assert.equal(oauthResultReads, 1);
  assert.equal(requests.filter(request => request.action === "account-create").length, createsBeforeAuthorization);
  assert.equal(new URL(page.url()).searchParams.has("oauthResult"), false);
  await page.reload();
  await page.getByRole("combobox", { name: "发布账号", exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "发布账号", exact: true }).inputValue(), createdId);
  assert.equal(oauthResultReads, 1);
  process.stdout.write("PASS: synthetic OAuth return selects the existing connected account, reports success and consumes its add marker without duplicating creation or replaying the result.\n");
  assert.deepEqual(pageErrors, []);
  process.stdout.write("PASS: known offline devices block create/connect and recover when online. Synthetic API only.\n");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("livepilot-account-connection-ui-")) throw new Error("Unsafe UI fixture cleanup");
  await rm(directory, { recursive: true, force: true });
}
