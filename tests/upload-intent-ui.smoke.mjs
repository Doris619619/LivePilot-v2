/** 失去创建回执后的真实上传组件恢复回归；同一文件经过identify/transfer，HTTP全部为合成回执。 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chromium, expect } from "playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const out = await mkdtemp(path.join(os.tmpdir(), "ln-upload-intent-")), root = process.cwd();
await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Upload from './src/app/upload-panel';const root=createRoot(document.getElementById('root'));let request;window.mount=(removed=false)=>root.render(<Upload instances={[{id:'main',name:'Main',agentId:'pc_a',agentName:'A'},...removed?[]:[{id:'main',name:'Second',agentId:'pc_b',agentName:'B'}]]} channels={{}} request={request}/>);window.otherTarget=()=>{request={target:'pc_a:main',kind:'videos',sequence:1};window.mount()};window.mount(new URLSearchParams(location.search).has('removed'));`, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", outfile: path.join(out, "ui.js"), jsx: "automatic", alias: { "@": path.join(root, "src") }, logLevel: "silent" });
const js = await readFile(path.join(out, "ui.js"));
const server = createServer((request, response) => { response.setHeader("Content-Type", request.url === "/ui.js" ? "text/javascript" : "text/html"); response.end(request.url === "/ui.js" ? js : '<!doctype html><div id="root"></div><script src="/ui.js"></script>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = "http://127.0.0.1:" + server.address().port;
const hash = createHash("sha256").update("original").digest("hex"), fingerprint = createHash("sha256").update(hash).digest("hex"); let browser; const errors = [];
/** 每例独立浏览器缓存；返回可检查的请求白名单与原意图，禁止外部地址。 */
async function open({ kind = "videos", removed = false, found = true, createStatus = 201, cancelStatus = 200, lost = false, faultRecordStorage = false } = {}) {
  const intent = { target: "pc_b:main", kind, requestId: crypto.randomUUID(), fingerprint };
  const context = await browser.newContext(); const page = await context.newPage(), calls = []; let stored = found;
  const value = { id: intent.requestId, instanceId: "main", agentId: "pc_b", kind, filename: kind === "music" ? "original.mp3" : "original.mp4", size: 8, received: 0, chunkSize: 8388608, fingerprint, status: "uploading", expiresAt: Date.now() + 86400000 };
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== origin) return route.abort(); if (!url.pathname.startsWith("/api/")) return route.continue();
    const body = request.method() === "POST" && url.pathname === "/api/uploads" ? request.postDataJSON() : undefined; calls.push({ method: request.method(), path: url.pathname, agentId: url.searchParams.get("agentId"), body });
    if (request.method() === "DELETE") return route.fulfill(cancelStatus === 200 ? { json: { ok: true } } : { status: cancelStatus, json: { error: "合成原设备不可用，取消尚未确认。" } });
    if (url.pathname === "/api/uploads" && request.method() === "POST") { stored = true; if (lost) { lost = false; return route.abort(); } return route.fulfill(createStatus === 201 ? { status: 201, json: { ...value, id: body.requestId, agentId: body.agentId, kind: body.kind } } : { status: createStatus, json: { error: "合成创建明确拒绝。" } }); }
    if (url.pathname === "/api/uploads") return route.fulfill({ json: stored ? [{ ...value, message: "合成恢复记录" }] : [] });
    if (request.method() === "PUT") return route.fulfill({ json: { ...value, received: 8 } });
    if (request.method() === "POST") return route.fulfill({ json: { ...value, received: 8, status: "complete" } });
    return route.fulfill(removed ? { status: 503, json: { error: "合成原设备不可用。" } } : stored ? { json: value } : { status: 404, json: { error: "合成原上传尚未找到。" } });
  });
  await page.addInitScript(({ intent, fault }) => {
    if (!sessionStorage.getItem("synthetic-intent-seeded")) { localStorage.setItem("livepilot-upload.intent", JSON.stringify(intent)); sessionStorage.setItem("synthetic-intent-seeded", "1"); }
    if (fault) { const write = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === "livepilot-upload") throw new DOMException("Synthetic record storage failure", "QuotaExceededError"); return write.call(this, key, value); }; }
  }, { intent, fault: faultRecordStorage }); await page.goto(origin + (removed ? "?removed" : "")); const opener = page.getByRole("button", { name: "上传素材", exact: true }); if (await opener.count()) await opener.click();
  return { page, context, calls, intent, value };
}
/** 使用原文件实际字节触发组件哈希，不替换identify或transfer。 */
async function choose(page, kind, body = "original") { await page.locator("#upload-file").setInputFiles({ name: kind === "music" ? "original.mp3" : "original.mp4", mimeType: kind === "music" ? "audio/mpeg" : "video/mp4", buffer: Buffer.from(body) }); }
try {
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge", headless: true });
  const storageFailure = await open({ kind: "music", faultRecordStorage: true }); await storageFailure.page.getByRole("button", { name: "查询原上传", exact: true }).click(); await expect(storageFailure.page.locator(".upload-progress-title")).toContainText(storageFailure.value.filename);
  expect(await storageFailure.page.evaluate(() => localStorage.getItem("livepilot-upload"))).toBeNull(); expect(await storageFailure.page.evaluate(() => JSON.parse(localStorage.getItem("livepilot-upload.intent")))).toEqual(storageFailure.intent);
  await storageFailure.page.reload(); await expect(storageFailure.page.locator(".upload-destination")).toContainText("B / Second"); await expect(storageFailure.page.getByRole("button", { name: "查询原上传", exact: true })).toBeVisible(); await expect(storageFailure.page.locator("#upload-file")).toHaveAttribute("accept", /\.mp3/); await storageFailure.context.close();
  for (const kind of ["videos", "music"]) {
    const item = await open({ kind }); const { page } = item;
    const oldSelector = await page.locator("#upload-instance").count(); expect(oldSelector ? await page.locator("#upload-instance").inputValue() : await page.locator(".upload-destination").textContent()).toMatch(/pc_b:main|B \/ Second/);
    await expect(page.locator("#upload-file")).toHaveAttribute("accept", kind === "music" ? /\.mp3/ : /\.mp4/); await page.evaluate(() => window.otherTarget()); await expect(page.getByText("已保留当前上传，请先完成或取消，再添加到其他 OBS。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查询原上传", exact: true }).click(); await expect(page.locator(".upload-progress-title")).toContainText(item.value.filename); await choose(page, kind); await page.getByRole("button", { name: "继续上传", exact: true }).click(); await expect(page.getByRole("button", { name: "上传下一个", exact: true })).toBeVisible(); expect(item.calls.filter(call => call.method === "PUT").every(call => call.agentId === "pc_b" && call.path.endsWith(item.intent.requestId))).toBe(true); expect(item.calls.filter(call => call.body)).toHaveLength(0); await item.context.close();
  }
  for (const createStatus of [201, 400]) {
    const item = await open({ kind: "music", found: false, createStatus }); await choose(item.page, "music", "mismatch"); await item.page.getByRole("button", { name: "继续上传", exact: true }).click(); await expect(item.page.getByText(/原上传|所选文件/, { exact: false }).first()).toBeVisible(); expect(item.calls.filter(call => call.body)).toHaveLength(0);
    await choose(item.page, "music"); await item.page.getByRole("button", { name: "继续上传", exact: true }).click(); await expect.poll(() => item.calls.filter(call => call.body).length).toBe(1); expect(item.calls.find(call => call.body).body).toMatchObject({ agentId: "pc_b", kind: "music", requestId: item.intent.requestId });
    if (createStatus === 400) { await expect(item.page.getByText("合成创建明确拒绝。", { exact: true }).first()).toBeVisible(); expect(await item.page.evaluate(() => JSON.parse(localStorage.getItem("livepilot-upload.intent")))).toEqual(item.intent); }
    else await expect(item.page.getByRole("button", { name: "上传下一个", exact: true })).toBeVisible(); await item.context.close();
  }
  const lost = await open({ found: false, lost: true }); await choose(lost.page, "videos"); await lost.page.getByRole("button", { name: "继续上传", exact: true }).click(); await expect(lost.page.getByText(/请求结果尚未确认/).first()).toBeVisible(); expect(await lost.page.evaluate(() => localStorage.getItem("livepilot-upload"))).toBeNull(); await lost.page.reload(); await lost.page.getByRole("button", { name: "查询原上传", exact: true }).click(); await expect(lost.page.locator(".upload-progress-title")).toContainText(lost.value.filename); expect(lost.calls.filter(call => call.body)).toHaveLength(1); await lost.context.close();
  for (const cancelStatus of [503, 200]) { const item = await open({ removed: true, cancelStatus }); await item.page.getByRole("button", { name: "查询原上传", exact: true }).click(); await expect(item.page.getByText("合成原设备不可用。", { exact: true }).first()).toBeVisible(); await item.page.getByRole("button", { name: "取消上传", exact: true }).first().click(); expect(item.calls.find(call => call.method === "DELETE")).toMatchObject({ agentId: "pc_b", path: "/api/uploads/" + item.intent.requestId }); if (cancelStatus === 503) expect(await item.page.evaluate(() => JSON.parse(localStorage.getItem("livepilot-upload.intent")))).toEqual(item.intent); else await expect(item.page.locator("#upload-instance")).toBeVisible(); await item.context.close(); }
  expect(errors).toEqual([]); console.log("PASS V03: original target/kind/requestId survive intent-only refresh, mismatched files and rejected/unknown create; query/cancel use the original handle even after target removal; only synthetic local API transfers.");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); if (path.dirname(out) !== os.tmpdir() || !path.basename(out).startsWith("ln-upload-intent-")) throw new Error("Unsafe cleanup"); await rm(out, { recursive: true, force: true }); }
