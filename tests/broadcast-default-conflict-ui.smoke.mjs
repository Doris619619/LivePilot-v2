/** 默认参数真实组件与真实路由回归：双标签冲突、明确放弃与失回执重试；仅使用隔离本地数据。 */
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
const root = process.cwd(), out = await mkdtemp(path.join(os.tmpdir(), "ln-defaults-conflict-"));
await mkdir(path.resolve(".data/defaults-conflict-ui"), { recursive: true });
const alias = { "@": path.join(root, "src"), "server-only": path.join(root, "tests/server-only.ts") };
await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Defaults from './src/app/components/broadcast-default-settings';import './src/app/globals.css';createRoot(document.getElementById('root')).render(<Defaults onSaving={()=>{}}/>);`, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", outfile: path.join(out, "ui.js"), jsx: "automatic", alias, logLevel: "silent" });
await build({ stdin: { contents: `export {GET,POST} from './src/app/api/broadcast-defaults/route';import {accessStore,digest} from './src/server/access';export async function seed(){await accessStore().write('access.json',{users:[{username:'alice',role:'customer',revision:'r1',disabled:false}],sessions:{[digest('b'.repeat(64))]:{username:'alice',revision:'r1',expires:Date.now()+86400000}},attempts:{}})}`, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: path.join(out, "route.mjs"), alias, logLevel: "silent" });
const handlers = await import(pathToFileURL(path.join(out, "route.mjs")).href), writes = [];
let origin, loseResponse = false;
const server = createServer(async (request, response) => {
  if (request.url === "/api/broadcast-defaults") {
    let body = ""; for await (const chunk of request) body += chunk;
    const req = new Request(origin + request.url, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
    const result = await handlers[request.method](req), text = await result.text();
    if (request.method === "POST") writes.push({ input: JSON.parse(body), status: result.status, result: JSON.parse(text) });
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(text); return;
  }
  const file = request.url === "/ui.js" ? "ui.js" : request.url === "/ui.css" ? "ui.css" : undefined;
  response.setHeader("Content-Type", file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html");
  response.end(file ? await readFile(path.join(out, file)) : '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><main style="padding:24px;max-width:900px"><div id="root"></div></main><script src="/ui.js"></script></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = "http://127.0.0.1:" + server.address().port;
process.env.LIVEPILOT_DATA_ROOT = path.join(out, "data"); process.env.LIVEPILOT_ORIGIN = origin; process.env.LIVEPILOT_ENCRYPTION_KEY = "a".repeat(64); await handlers.seed();
let browser; const errors = [];
try {
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } }); await context.addCookies([{ name: "livepilot_session", value: "b".repeat(64), url: origin }]); await context.route("**/*", async route => { if (!route.request().url().startsWith(origin)) return route.abort(); if (loseResponse && route.request().method() === "POST") { loseResponse = false; await route.fetch(); return route.abort(); } return route.continue(); });
  const a = await context.newPage(), b = await context.newPage(); for (const page of [a, b]) { page.on("pageerror", error => errors.push(error.message)); await page.goto(origin); await expect(page.getByLabel("公开范围", { exact: true })).toHaveValue("public"); }
  await b.getByLabel("保留视频原声", { exact: true }).check(); await a.getByLabel("公开范围", { exact: true }).selectOption("private"); await a.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(a.getByText("默认参数已保存，供新建直播使用。", { exact: true })).toBeVisible();
  await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(b.getByRole("alert")).toContainText("其他窗口修改");
  await b.getByRole("button", { name: "重新读取默认参数", exact: true }).click(); await expect(b.getByLabel("保留视频原声", { exact: true })).toBeChecked();
  await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect.poll(() => writes.length).toBe(3); expect(writes.at(-1).input.revision).toBe(0); expect(writes.at(-1).status).toBe(409);
  await b.getByRole("button", { name: "放弃草稿并载入最新默认参数", exact: true }).click(); await expect(b.getByLabel("公开范围", { exact: true })).toHaveValue("private"); await expect(b.getByLabel("保留视频原声", { exact: true })).not.toBeChecked();
  await b.getByLabel("保留视频原声", { exact: true }).check(); await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(b.getByText("默认参数已保存，供新建直播使用。", { exact: true })).toBeVisible(); expect(writes.at(-1).result.value).toEqual({ privacy: "private", madeForKids: false, videoAudio: true });
  for (const [field, first, second] of [["是否面向儿童", "true", "false"], ["公开范围", "unlisted", "private"]]) {
    await a.reload(); await b.reload(); await a.getByLabel(field, { exact: true }).selectOption(first); await b.getByLabel(field, { exact: true }).selectOption(second); await a.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(a.getByText("默认参数已保存，供新建直播使用。", { exact: true })).toBeVisible(); await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(b.getByRole("alert")).toContainText("其他窗口修改");
  }
  await b.getByRole("button", { name: "放弃草稿并载入最新默认参数", exact: true }).click(); await expect(b.getByLabel("公开范围", { exact: true })).toHaveValue("unlisted");
  await b.getByLabel("保留视频原声", { exact: true }).uncheck(); loseResponse = true; await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(b.getByRole("alert")).toContainText("结果尚未确认"); const lost = writes.at(-1); await b.getByRole("button", { name: "保存默认参数", exact: true }).click(); await expect(b.getByText("默认参数已保存，供新建直播使用。", { exact: true })).toBeVisible(); expect(writes.at(-1).input).toEqual(lost.input); expect(writes.at(-1).result.revision).toBe(lost.result.revision);
  await b.screenshot({ path: path.resolve(".data/defaults-conflict-ui/desktop.png"), fullPage: true }); await b.setViewportSize({ width: 390, height: 844 }); expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await b.screenshot({ path: path.resolve(".data/defaults-conflict-ui/mobile.png"), fullPage: true }); expect(errors).toEqual([]);
  console.log("PASS V07: real React+Edge and authenticated GET/POST preserve draft revision across refresh, explicitly discard, protect privacy/audience/audio, and retry a lost response idempotently. No external requests.");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); if (path.dirname(out) !== os.tmpdir() || !path.basename(out).startsWith("ln-defaults-conflict-")) throw new Error("Unsafe cleanup"); await rm(out, { recursive: true, force: true }); }
