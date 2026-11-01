/** 发布账号连接回归：真实浏览器与组件使用合成 API，禁止访问真实 Agent、OAuth 或 YouTube。 */
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
const offlineMessage = "设备离线，请打开这台电脑的 LiveNest，待设备上线后再连接频道。";
const rejectedMessage = "设备已离线，连接频道失败，请打开这台电脑的 LiveNest 后重试。";
const view = createPublishingPreview().view;
Object.assign(view, { profiles: [], templates: [], jobs: [], plans: [], cleanups: [], administrator: false, accounts: [{ id: initialId, agentId: "synthetic_pc", instanceId: "main", name: "原有账号", owner: "tester", status: "unbound", createdAt: 1, updatedAt: 1 }] });
const requests = [];
const pageErrors = [];
const externalRequests = [];
let online = true;
let reads = 0;
let connectionSucceeds = false;
const screenshotDirectory = process.env.LIVEPILOT_ACCOUNT_UI_SCREENSHOTS && path.resolve(process.env.LIVEPILOT_ACCOUNT_UI_SCREENSHOTS);
const entry = `import React from "react"; import {createRoot} from "react-dom/client"; import "./src/app/globals.css"; import PublishingConsole from "./src/app/publishing/publishing-console"; createRoot(document.getElementById("root")).render(<PublishingConsole/>);`;
await build({ stdin: { contents: entry, resolveDir: repo, loader: "tsx" }, outfile: path.join(directory, "probe.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": path.join(repo, "src") }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "silent" });
const javascript = await readFile(path.join(directory, "probe.js"));
const css = await readFile(path.join(directory, "probe.css"));
/** 只提供本次编译的静态组件；所有 API 由浏览器白名单拦截。 */
const server = http.createServer((request, response) => {
  if (request.url === "/probe.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
  else if (request.url === "/probe.css") { response.setHeader("content-type", "text/css"); response.end(css); }
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
  await page.clock.install();
  await page.goto(origin + "/publishing");
  await page.getByRole("button", { name: "发布账号", exact: true }).click();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.waitForFunction(id => document.querySelector('select[aria-label="发布账号"]')?.value === id, createdId);
  await page.getByText(rejectedMessage, { exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  process.stdout.write("PASS: failed connection remains visible after creating and selecting the account.\n");

  const createdRow = page.getByRole("region", { name: "发布账号 发布账号 2", exact: true });
  await createdRow.getByRole("alert").getByText(rejectedMessage, { exact: true }).waitFor();
  await createdRow.getByRole("button", { name: "连接频道", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('select[aria-label="发布账号"]')?.disabled);
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  assert.equal(requests.filter(request => request.action === "account-connect" && request.accountId === createdId).length, 2);
  const readsBefore = reads;
  const refreshed = page.waitForResponse(response => response.url() === origin + "/api/publishing" && response.request().method() === "GET");
  await page.clock.runFor(11000);
  await refreshed;
  assert.ok(reads > readsBefore);
  await createdRow.getByText(rejectedMessage, { exact: true }).waitFor();
  process.stdout.write("PASS: retry uses the same account and background refresh preserves the failure.\n");

  const initialRow = page.getByRole("region", { name: "发布账号 原有账号", exact: true });
  await initialRow.getByRole("button", { name: "连接频道", exact: true }).click();
  await initialRow.getByRole("alert").getByText("原有账号的合成连接失败", { exact: true }).waitFor();
  assert.equal(await createdRow.getByText("原有账号的合成连接失败", { exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "发布账号", exact: true }).selectOption(initialId);
  await page.getByRole("button", { name: "发布视频", exact: true }).click();
  await page.getByRole("alert").getByText("原有账号的合成连接失败", { exact: true }).waitFor();
  assert.equal(await page.getByText(rejectedMessage, { exact: true }).isVisible().catch(() => false), false);
  process.stdout.write("PASS: another account's connection failure stays attached to its row and selection.\n");

  online = false;
  await page.getByRole("button", { name: "发布账号", exact: true }).click();
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.getByText(offlineMessage, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).isDisabled(), true);
  assert.equal(await initialRow.getByRole("button", { name: "连接频道", exact: true }).isDisabled(), true);
  assert.equal(requests.filter(request => request.action === "account-create").length, 1);
  online = true;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && !button.disabled));
  assert.equal(await initialRow.getByRole("button", { name: "连接频道", exact: true }).isEnabled(), true);
  online = false;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && button.disabled));
  online = undefined;
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "添加账号" && !button.disabled));
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).isEnabled(), true);
  assert.equal(await initialRow.getByRole("button", { name: "连接频道", exact: true }).isEnabled(), true);
  assert.equal(await page.getByText(offlineMessage, { exact: true }).count(), 0);
  process.stdout.write("PASS: unknown device status remains actionable instead of being treated as offline.\n");

  online = true; view.accounts = [];
  await page.reload();
  await page.getByRole("heading", { name: "发布视频", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
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
  const unboundData = page.locator("details").filter({ has: page.locator("summary").getByText(/ · 发布账号 1$/) });
  assert.equal(await unboundData.locator("summary").innerText(), "账号数据 · 发布账号 1");
  await unboundData.locator("summary").click();
  assert.equal(await unboundData.locator('a[href="https://security.google.com/settings/security/permissions"]').count(), 0, "A never-connected account must not show the Google authorization-management link");
  await unboundData.getByText("此发布账号尚未连接频道，请使用账号行右侧的“连接频道”。", { exact: true }).waitFor();
  await unboundData.getByRole("button", { name: "删除账号与数据", exact: true }).click();
  await unboundData.getByRole("button", { name: "确认删除账号与数据", exact: true }).waitFor();
  await unboundData.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(requests.some(request => request.action === "account-cleanup"), false);
  process.stdout.write("PASS: never-connected accounts guide users to Connect channel and keep deletion under Account data.\n");

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
    { name: "已连接账号", status: "connected" },
    { name: "需重新授权账号", status: "needs_reauthorization" },
    { name: "保留频道的账号", status: "unbound", channelId: "synthetic_old_channel" },
    { name: "保留连接时间的账号", status: "unbound", connectedAt: 10 },
  ];
  for (const [index, history] of historyCases.entries()) view.accounts.push({ ...view.accounts[0], ...history, id: String(index + 3).repeat(8) + "-1111-4111-8111-111111111111" });
  const cleanupCases = [{ name: "未连接账号待清理", status: "cleanup_pending" }, { name: "历史账号待清理", status: "cleanup_pending", channelId: "synthetic_cleanup_channel" }];
  for (const [index, pending] of cleanupCases.entries()) view.accounts.push({ ...view.accounts[0], ...pending, id: String(index + 7).repeat(8) + "-1111-4111-8111-111111111111" });
  const legacyProfile = { ...createPublishingPreview().view.profiles[0], agentId: "synthetic_pc", instanceId: "main" }; delete legacyProfile.accountId;
  view.profiles = [legacyProfile];
  await page.getByRole("button", { name: "刷新发布状态", exact: true }).click();
  for (const history of historyCases) {
    const data = page.locator("details").filter({ has: page.locator("summary").getByText(new RegExp(" · " + history.name + "$")) });
    await data.locator("summary").click();
    const link = data.getByRole("link", { name: "查看或撤销 Google 授权", exact: true });
    assert.equal(await link.getAttribute("href"), "https://security.google.com/settings/security/permissions");
    await data.getByText("此入口用于管理已有授权，连接频道请使用账号行中的按钮。", { exact: true }).waitFor();
    await data.getByRole("button", { name: "撤销授权与删除数据", exact: true }).waitFor();
    await data.locator("summary").click();
  }
  for (const pending of cleanupCases) {
    const data = page.locator("details").filter({ has: page.locator("summary").getByText(new RegExp(" · " + pending.name + "$")) });
    await data.locator("summary").click();
    await data.getByText("此账号正在等待设备完成清理，请保持设备在线。清理完成后如需连接频道，请添加新账号。", { exact: true }).waitFor();
    assert.equal(await data.getByText(/连接频道请使用账号行|请使用账号行右侧/).count(), 0);
    assert.equal(await data.getByRole("link", { name: "查看或撤销 Google 授权", exact: true }).count(), pending.channelId ? 1 : 0);
    assert.equal(await page.getByRole("region", { name: "发布账号 " + pending.name, exact: true }).getByRole("button", { name: "连接频道", exact: true }).isDisabled(), true);
    assert.equal(await data.getByRole("button", { name: pending.channelId ? "撤销授权与删除数据" : "删除账号与数据", exact: true }).isDisabled(), true);
    await data.locator("summary").click();
  }
  process.stdout.write("PASS: cleanup-pending accounts explain device cleanup without directing users to their disabled connection buttons.\n");
  const legacyData = page.locator("details").filter({ has: page.locator("summary").getByText("旧版任务授权", { exact: true }) });
  await legacyData.locator("summary").click();
  assert.equal(await legacyData.getByRole("link", { name: "查看或撤销 Google 授权", exact: true }).getAttribute("href"), "https://security.google.com/settings/security/permissions");
  await legacyData.getByText("此入口用于查看或撤销旧实例已有的 Google 授权。", { exact: true }).waitFor();
  assert.equal(await legacyData.getByText(/连接频道请使用账号行|请使用账号行右侧/).count(), 0);
  await legacyData.getByText("撤销旧实例的授权，并删除保存的 YouTube 数据。", { exact: true }).waitFor();
  process.stdout.write("PASS: connected, reauthorization, retained-channel, retained-connection-time and legacy accounts retain explicit authorization management.\n");

  connectionSucceeds = true;
  const createsBeforeAuthorization = requests.filter(request => request.action === "account-create").length;
  const connectionsBeforeAuthorization = requests.filter(request => request.action === "account-connect").length;
  await page.getByRole("region", { name: "发布账号 发布账号 1", exact: true }).getByRole("button", { name: "连接频道", exact: true }).click();
  await page.getByRole("heading", { name: "合成Google授权页", exact: true }).waitFor();
  assert.equal(requests.filter(request => request.action === "account-create").length, createsBeforeAuthorization);
  assert.equal(requests.filter(request => request.action === "account-connect").length, connectionsBeforeAuthorization + 1);
  assert.equal(requests.at(-1).accountId, createdId);
  assert.equal(new URL(page.url()).origin, "https://accounts.google.com");
  assert.equal(new URL(page.url()).pathname, "/o/oauth2/v2/auth");
  assert.deepEqual(externalRequests, [{ origin: "https://accounts.google.com", pathname: "/o/oauth2/v2/auth" }]);
  process.stdout.write("PASS: Connect channel reuses the selected account and opens only the intercepted synthetic OAuth consent page, never Google authorization management.\n");
  assert.deepEqual(pageErrors, []);
  process.stdout.write("PASS: known offline devices block create/connect and recover when online. Synthetic API only.\n");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("livepilot-account-connection-ui-")) throw new Error("Unsafe UI fixture cleanup");
  await rm(directory, { recursive: true, force: true });
}
