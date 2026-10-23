/** 文件用途：用真实浏览器和全模拟接口回归共享组件的输入法、草稿、字段错误、配置目录焦点与分页，不连接客户设备或外部服务。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const output = await mkdtemp(path.join(os.tmpdir(), "ln-guideline-components-"));
const requests = [];
let account = { revision: 1, configured: true, uses: { copy: true, chat: true } };
const profiles = Array.from({ length: 200 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, revision: 1, name: `模拟视频配置 ${index + 1}`,
  titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", privacy: "public", scheduled: true, madeForKids: false,
  license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "matching",
  ai: { enabled: false, language: "English", prompt: "模拟描述", fallbackTitle: "{{packageName}}", fallbackDescription: "" },
  schedule: { timezone: "UTC", weekdays: [1], localTime: "20:00", startDate: "2026-10-23", preuploadDays: 28 },
}));

await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Preview from './src/app/components/live-chat-preview';
    import {ApiSettingsProvider,ApiSettingsButton} from './src/app/components/api-settings';
    import Profiles from './src/app/components/publishing-profile-settings';
    import CopyFields from './src/app/components/broadcast-copy-fields';
    import {VideoIcon} from './src/app/components/icons';
    import {defaultLiveChatConfig} from './src/shared/live-chat';
    import {defaultBroadcast} from './src/shared/broadcast';
    import './src/app/globals.css'; import './src/app/components/ui/ui.css'; import './src/app/components/live-chat-fields.css';
    const noop=()=>{}; const mode=new URLSearchParams(location.search).get('panel');
    const content=mode==='preview'?<><Preview config={defaultLiveChatConfig} instanceId="synthetic"/><Preview compact config={defaultLiveChatConfig} instanceId="synthetic"/><CopyFields id="fixture" value={defaultBroadcast()} disabled={false} onChange={noop}/><VideoIcon/></>:
      mode==='profiles'?<Profiles onSaving={noop}/>:<ApiSettingsProvider><ApiSettingsButton>打开测试设置</ApiSettingsButton><a href="/elsewhere">离开测试页</a></ApiSettingsProvider>;
    createRoot(document.getElementById('root')).render(content);`, resolveDir: root, loader: "tsx" },
  bundle: true, platform: "browser", outfile: path.join(output, "ui.js"), jsx: "automatic", alias: { "@": path.join(root, "src") }, logLevel: "silent",
});

/** 只提供此测试的静态资源与合成 API；所有未知请求立即拒绝。 */
async function respond(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = body ? JSON.parse(body) : undefined;
  if (url.pathname.startsWith("/api/")) {
    requests.push({ path: url.pathname, input });
    let data;
    if (url.pathname === "/api/live-chat" && input?.action === "preview") data = { action: "reply", reply: "模拟回复", reason: "conversation" };
    else if (url.pathname === "/api/account-ai") {
      if (request.method === "POST") account = { ...account, revision: account.revision + 1, uses: input.uses };
      data = account;
    } else if (url.pathname === "/api/publishing-templates") {
      if (request.method === "POST") data = input;
      else data = { profiles };
    } else if (url.pathname === "/api/broadcast-profiles") data = { profiles: [] };
    else if (url.pathname === "/api/broadcast-defaults") data = { revision: 1, value: { privacy: "public", madeForKids: false, videoAudio: false } };
    else { response.writeHead(409); response.end('{"error":"测试拒绝未约定的请求"}'); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(data)); return;
  }
  const filename = url.pathname === "/ui.js" ? "ui.js" : url.pathname === "/ui.css" ? "ui.css" : undefined;
  response.setHeader("content-type", filename?.endsWith("js") ? "text/javascript" : filename ? "text/css" : "text/html");
  response.end(filename ? await readFile(path.join(output, filename)) : '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><main style="padding:24px;max-width:1000px"><div id="root"></div></main><script src="/ui.js"></script></html>');
}
const server = createServer((request, response) => { void respond(request, response); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ ...(process.env.LIVEPILOT_UI_BROWSER || process.platform === "win32" ? { channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "?panel=preview");
  for (const label of ["模拟观众留言", "观众留言"]) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill("中文候选词");
    const previous = requests.filter(request => request.path === "/api/live-chat").length;
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
    await expect(input).toHaveValue("中文候选词");
    assert.equal(requests.filter(request => request.path === "/api/live-chat").length, previous);
    await input.press("Enter");
    await expect(input).toHaveValue("");
    assert.equal(requests.filter(request => request.path === "/api/live-chat").length, previous + 1);
  }
  await expect(page.getByLabel("标题 必填")).toHaveAttribute("name", "broadcastTitle");
  await expect(page.getByLabel("说明", { exact: true })).toHaveAttribute("autocomplete", "off");
  assert.equal(await page.locator("svg:not([aria-hidden=true])").count(), 0);

  await page.goto(origin + "?panel=api");
  await page.getByRole("button", { name: "打开测试设置" }).click();
  const key = page.getByLabel("更换 API Key", { exact: true });
  await expect(key).toBeEnabled();
  await key.fill("abc");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(key).toBeFocused(); await expect(key).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#api-key-error")).toBeVisible();
  assert.equal(requests.filter(request => request.path === "/api/account-ai" && request.input).length, 0);
  await key.fill("synthetic_key_123456");
  await page.getByRole("checkbox", { name: "文案生成" }).uncheck();
  account = { ...account, revision: 2, uses: { copy: true, chat: false } };
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(key).toBeEnabled(); await expect(key).toHaveValue("synthetic_key_123456");
  await expect(page.getByRole("checkbox", { name: "文案生成" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "观众互动" })).not.toBeChecked();
  assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(key).toHaveValue("");
  assert.equal(account.uses.copy, false);
  assert.equal(account.uses.chat, false);
  await expect.poll(() => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);

  await page.goto(origin + "?panel=profiles");
  await expect(page.locator(".profile-library-row")).toHaveCount(20);
  await expect(page.getByRole("navigation", { name: "视频发布配置包分页" })).toContainText("共 200 个");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const edit = page.getByRole("button", { name: "编辑 模拟视频配置 21", exact: true });
  await expect(edit).toBeFocused();
  await edit.click(); await expect(page.getByRole("heading", { name: "编辑视频发布配置包", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "返回", exact: true }).click(); await expect(edit).toBeFocused();
  await edit.click(); await page.getByLabel("配置名称", { exact: true }).fill("已改名的模拟配置");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续编辑配置包", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "继续编辑配置包", exact: true }).click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue("已改名的模拟配置");
  await page.getByRole("button", { name: "保存配置包", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑 已改名的模拟配置", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "新建视频发布配置包", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新建视频发布配置包", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("button", { name: "新建视频发布配置包", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS: F04 IME/Enter, F07 dirty unload, F11 field focus, F12 profile focus, F19 draft reread, F20 200-template pagination, F24/F25 semantics; all APIs synthetic.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(output) !== os.tmpdir() || !path.basename(output).startsWith("ln-guideline-components-")) throw new Error("Unsafe cleanup");
  await rm(output, { recursive: true, force: true });
}
