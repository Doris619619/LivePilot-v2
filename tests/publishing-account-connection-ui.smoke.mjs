/** 发布账号连接回归：真实浏览器与组件使用合成 API，禁止访问真实 Agent、OAuth 或 YouTube。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
let online = true;
let reads = 0;
const entry = `import React from "react"; import {createRoot} from "react-dom/client"; import PublishingConsole from "./src/app/publishing/publishing-console"; createRoot(document.getElementById("root")).render(<PublishingConsole/>);`;
await build({ stdin: { contents: entry, resolveDir: repo, loader: "tsx" }, outfile: path.join(directory, "probe.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": path.join(repo, "src") }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "silent" });
const javascript = await readFile(path.join(directory, "probe.js"));
const css = await readFile(path.join(directory, "probe.css"));
/** 只提供本次编译的静态组件；所有 API 由浏览器白名单拦截。 */
const server = http.createServer((request, response) => {
  if (request.url === "/probe.js") { response.setHeader("content-type", "text/javascript"); response.end(javascript); }
  else if (request.url === "/probe.css") { response.setHeader("content-type", "text/css"); response.end(css); }
  else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script src="/probe.js"></script>'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  /** 未声明的请求立即失败，外部域名一律阻断。 */
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
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
  assert.deepEqual(pageErrors, []);
  process.stdout.write("PASS: known offline devices block create/connect and recover when online. Synthetic API only.\n");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("livepilot-account-connection-ui-")) throw new Error("Unsafe UI fixture cleanup");
  await rm(directory, { recursive: true, force: true });
}
