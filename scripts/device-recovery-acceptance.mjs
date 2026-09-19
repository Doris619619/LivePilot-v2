/** 网页移除/恢复邀请验收：临时 Next 服务及模拟 API，不访问真实账号或生产数据。 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const root = await mkdtemp(path.join(os.tmpdir(), "ln-device-ui-"));
const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { windowsHide: true, env: { ...process.env, LIVEPILOT_MODE: "cloud", LIVEPILOT_DATA_ROOT: root, LIVEPILOT_ACCESS_DIR: path.join(root, "access"), LIVEPILOT_ORIGIN: origin }, stdio: "ignore" });
const exited = new Promise(resolve => child.once("exit", resolve));
let browser;
try {
  for (let n = 0; n < 80; n++) { if (child.exitCode !== null) throw new Error("Fixture server exited"); try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 250)); }
  browser = await chromium.launch({ channel: "msedge", headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 880 } }); const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const agent = { id: "pc_fixture", name: "示例 PC", paired: true, online: false, revoked: false, lastSeen: 0, instances: [] }; let attempts = 0; let release;
  /** 只实现本测试需要的固定响应，意外请求直接失败。 */
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); let body;
    if (url.pathname === "/api/session") body = { user: { username: "fixture" } };
    else if (url.pathname === "/api/instances") body = { instances: [], agents: [agent] };
    else if (url.pathname === "/api/devices") {
      assert.equal(route.request().method(), "DELETE"); assert.deepEqual(route.request().postDataJSON(), { agentId: agent.id, confirmed: true }); attempts++;
      if (attempts === 1) { await new Promise(resolve => { release = resolve; }); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "结果尚未确认，请重试" }) }); return; }
      agent.revoked = true; body = { ok: true };
    } else if (url.pathname === "/api/devices/pairing") { assert.equal(route.request().postDataJSON().agentId, agent.id); body = { agentId: agent.id, invitation: "LN1.synthetic-example-only" }; }
    else throw new Error("Unexpected API: " + url.pathname);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(origin); await page.getByRole("button", { name: "移除电脑", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(attempts, 0);
  await page.getByRole("button", { name: "移除电脑", exact: true }).click(); await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "正在移除…" && b.disabled));
  while (!release) await new Promise(resolve => setTimeout(resolve, 20)); release();
  await page.getByText("结果尚未确认，请重试", { exact: true }).waitFor();
  await mkdir("docs/desktop/screenshots", { recursive: true }); await page.screenshot({ path: "docs/desktop/screenshots/device-removal.png" });
  await page.getByRole("button", { name: "确认移除", exact: true }).click(); await page.locator("#device-pc_fixture").waitFor({ state: "detached" }); assert.equal(attempts, 2);
  await page.getByRole("button", { name: "添加直播电脑", exact: true }).click(); await page.getByRole("combobox").selectOption(agent.id);
  await page.getByText(/原电脑的 LiveNest/).waitFor(); await page.getByRole("button", { name: "重新生成配对信息", exact: true }).click();
  await page.getByRole("textbox", { name: "配对信息（10 分钟内有效）", exact: true }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "添加直播电脑", exact: true }).click(); assert.equal(await page.locator("#device-pc_fixture").count(), 0);
  await page.getByRole("combobox").selectOption(agent.id); await page.setViewportSize({ width: 800, height: 750 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []); console.log("Device recovery UI passed: cancel, pending dedupe, failed removal retained, confirmed removal, recovery invitation and refresh (mock API only).");
} finally { await browser?.close(); if (child.exitCode === null) child.kill(); await exited; }
