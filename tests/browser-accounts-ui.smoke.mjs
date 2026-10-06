/** 网页多账号交互验收：仅模拟服务端成员，验证切换、首次登录、跨标签页和移动端布局。 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3077";
const browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
const context = await browser.newContext();
const alice = { username: "alice", role: "customer" }; const admin = { username: "UTest", role: "admin" };
let user = alice; let accounts = [alice]; let enforceExpected = false; const errors = []; const memberRequests = [];
/** 接口只返回合成数据，新增账号需显式登录；已登录切换不会再请求密码。 */
async function route(route) {
  const request = route.request(); const url = new URL(request.url()); const body = request.method() === "POST" ? request.postDataJSON() : {};
  let result;
  if (url.pathname === "/api/session/accounts") {
    if (request.method() === "POST") { user = accounts.find(account => account.username === body.username); assert.ok(user); result = { user }; }
    else result = { accounts: accounts.map(account => ({ ...account, current: account.username === user?.username })) };
  } else if (url.pathname === "/api/session") {
    if (request.method() === "POST") { assert.equal(body.username, admin.username); assert.equal(body.password, "synthetic-pass-123"); user = admin; accounts.push(admin); }
    if (request.method() === "DELETE") { accounts = accounts.filter(account => account.username !== user.username); user = undefined; result = { ok: true }; }
    else if (!user) { await route.fulfill({ status: 401, json: { error: "请登录后继续。" } }); return; }
    else result = { user };
  } else {
    if (enforceExpected && request.headers()["x-livepilot-user"] && request.headers()["x-livepilot-user"] !== user?.username) { await route.fulfill({ status: 409, json: { problem: { version: 1, source: "http", code: "ACCOUNT_CHANGED", domain: "account", target: {}, severity: "error", stage: "读取状态", outcome: "rejected", observedAt: Date.now(), message: "账号已切换，请刷新页面后继续。", actions: ["refresh"] } } }); return; }
    if (request.headers()["x-livepilot-user"]) memberRequests.push(request.headers()["x-livepilot-user"]);
    if (url.pathname === "/api/instances") result = { instances: [] };
    if (url.pathname === "/api/publishing") result = { profiles: [], jobs: [], plans: [], accounts: [], policy: {}, cleanups: [], administrator: user?.role === "admin" };
  }
  if (!result) { await route.fulfill({ status: 404, json: { error: "Unexpected mocked request" } }); return; }
  await route.fulfill({ json: result });
}
try {
  await context.route("**/api/**", route); const page = await context.newPage(); const other = await context.newPage();
  for (const item of [page, other]) item.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/publishing"); await other.goto(origin + "/publishing");
  await page.getByRole("heading", { name: "发布视频", exact: true }).waitFor();
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: "＋ 添加登录账号", exact: true }).click();
  await page.getByRole("form", { name: "添加登录账号" }).getByLabel("账号", { exact: true }).fill(admin.username);
  await page.getByRole("form", { name: "添加登录账号" }).getByLabel("密码", { exact: true }).fill("synthetic-pass-123");
  await page.getByRole("button", { name: "登录并切换", exact: true }).click();
  await page.getByRole("link", { name: "管理员总览", exact: true }).waitFor(); await other.getByRole("link", { name: "管理员总览", exact: true }).waitFor();
  await mkdir(".data/publishing-ui", { recursive: true });
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: /alice.*切换/ }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.data/publishing-ui/accounts-${width}.png`, fullPage: true }); await page.keyboard.press("Escape");
  }
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: /alice.*切换/ }).waitFor(); await page.getByRole("heading", { name: "发布视频", exact: true }).click(); await page.locator(".account-switcher-panel").waitFor({ state: "hidden" });
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: /alice.*切换/ }).click();
  await page.getByLabel("切换登录账号").filter({ hasText: "alice" }).waitFor(); await page.getByRole("heading", { name: "发布视频", exact: true }).waitFor(); assert.equal(await page.getByRole("link", { name: "管理员总览", exact: true }).count(), 0);
  await other.getByLabel("切换登录账号").filter({ hasText: "alice" }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: /UTest.*切换/ }).click(); await page.getByRole("link", { name: "管理员总览", exact: true }).waitFor();
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: "退出当前账号", exact: true }).click(); await page.getByRole("heading", { name: "LiveNest 控制台" }).waitFor();
  await page.getByLabel("切换登录账号").click(); await page.getByRole("button", { name: /alice.*切换/ }).click(); await page.getByRole("heading", { name: "发布视频", exact: true }).waitFor();
  // 禁止浏览器存储通知时，旧标签的身份请求被拒绝后仍能重载当前账号。
  const stale = await context.newPage(); stale.on("pageerror", error => errors.push(error.message)); await stale.addInitScript(() => { Object.defineProperty(Storage.prototype, "setItem", { value() { throw new Error("Storage disabled for smoke"); } }); });
  await stale.goto(origin + "/publishing"); await stale.getByRole("heading", { name: "发布视频", exact: true }).waitFor(); user = admin; accounts = [alice, admin]; enforceExpected = true;
  await stale.getByRole("button", { name: "刷新发布状态", exact: true }).click(); await stale.getByRole("link", { name: "管理员总览", exact: true }).waitFor(); await stale.close();
  assert.ok(memberRequests.includes("alice")); assert.ok(memberRequests.includes("UTest")); assert.deepEqual(errors, []);
  console.log("Browser account smoke passed: add, switch without password, logout isolation, two tabs, blocked-storage recovery, four widths.");
} finally { await browser.close(); }
