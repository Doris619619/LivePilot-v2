/** 真实 UploadPanel/Dropzone 浏览器回归：离线关闭完成记录、取消确认和跨类型续传；只访问合成本地 API。 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chromium, expect } from "playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const repo = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), "ln-upload-recovery-ui-"));
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import UploadPanel from './src/app/upload-panel';import {WorkspaceUserContext} from './src/app/components/workspace-user-context'; createRoot(document.getElementById('root')).render(<WorkspaceUserContext.Provider value={{username:"alice",role:"customer"}}><UploadPanel instances={[{id:'main',name:'Main',agentId:'pc_a',agentName:'A'},{id:'main',name:'Second',agentId:'pc_b',agentName:'B'}]} channels={{}}/></WorkspaceUserContext.Provider>);`, resolveDir: repo, loader: "tsx" }, outfile: path.join(output, "ui.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": path.join(repo, "src") }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent" });
const js = await readFile(path.join(output, "ui.js"));
const server = http.createServer((request, response) => { response.setHeader("content-type", request.url === "/ui.js" ? "text/javascript" : "text/html"); response.end(request.url === "/ui.js" ? js : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/ui.js"></script>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
const errors = [];
/** 构造公开上传 DTO，偏移和过期时间均为测试值。 */
function record(kind, status = "uploading") { const hash = createHash("sha256").update("original").digest("hex"); return { id: crypto.randomUUID(), instanceId: "main", agentId: "pc_a", kind, filename: kind === "music" ? "original.mp3" : "original.mp4", size: 8, received: status === "complete" ? 8 : 4, chunkSize: 8388608, fingerprint: createHash("sha256").update(hash).digest("hex"), status, expiresAt: Date.now() + 86400000 }; }
/** 每例使用新浏览器存储，所有 API 由合成回执替换并阻断外部访问。 */
async function open({ saved, recovery, cancelStatus = 503, delayRecovery = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); const calls = [];
  let releaseRecovery; const gate = new Promise(resolve => { releaseRecovery = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== origin) return route.abort(); if (!url.pathname.startsWith("/api/")) return route.continue();
    calls.push({ method: request.method(), path: url.pathname });
    if (request.method() === "DELETE") return route.fulfill(cancelStatus === 200 ? { json: { ok: true } } : { status: cancelStatus, json: { error: "直播电脑离线，尚未下发新任务。" } });
    if (url.pathname === "/api/uploads") return route.fulfill({ json: recovery ? [{ ...recovery, message: "合成未完成记录" }] : [] });
    const selected = recovery && url.pathname.startsWith("/api/uploads/" + recovery.id) ? recovery : saved;
    if (request.method() === "PUT") return route.fulfill({ json: { ...selected, received: selected.size } });
    if (request.method() === "POST" && url.pathname.endsWith("/complete")) return route.fulfill({ json: { ...selected, received: selected.size, status: "complete" } });
    if (delayRecovery && recovery && url.pathname === "/api/uploads/" + recovery.id) await gate;
    if (saved && url.pathname === "/api/uploads/" + saved.id) return route.fulfill({ json: saved });
    return route.fulfill({ json: recovery || saved });
  });
  if (saved) await page.addInitScript(value => localStorage.setItem("livepilot-upload.v2:alice:"+value.id+":record", JSON.stringify({member:"alice",updatedAt:Date.now(),value})), saved);
  await page.goto(origin);
  if (!saved) await page.getByRole("button", { name: "上传素材", exact: true }).click();
  return { context, page, calls, releaseRecovery };
}
try {
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge", headless: true });
  for (const [initialKind, recoveredKind] of [["videos", "music"], ["music", "videos"], ["videos", "videos"]]) {
    const current = record(initialKind), alternate = record(recoveredKind); alternate.received = 0; alternate.filename = "alternate." + (recoveredKind === "music" ? "mp3" : "mp4");
    const pending = await open({ saved: current, recovery: alternate, delayRecovery: true }); const page = pending.page;
    await expect(page.locator(".upload-progress-title")).toContainText(current.filename);
    await page.locator("#upload-file").setInputFiles({ name: current.filename, mimeType: initialKind === "music" ? "audio/mpeg" : "video/mp4", buffer: Buffer.from("original") });
    await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeEnabled();
    await page.locator(".upload-recovery summary").click(); await page.getByRole("button", { name: "查询／恢复", exact: true }).click();
    try { await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeDisabled(); }
    finally { pending.releaseRecovery(); }
    await expect(page.locator(".upload-progress-title")).toContainText(alternate.filename);
    await expect(page.locator("#upload-file")).toHaveAttribute("accept", recoveredKind === "music" ? /\.mp3/ : /\.mp4/);
    await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeDisabled();
    expect(pending.calls.every(call => call.method === "GET")).toBe(true);
    await page.locator("#upload-file").setInputFiles({ name: alternate.filename, mimeType: recoveredKind === "music" ? "audio/mpeg" : "video/mp4", buffer: Buffer.from("original") });
    await page.getByRole("button", { name: "继续上传", exact: true }).click(); await expect(page.getByRole("button", { name: "上传下一个", exact: true })).toBeVisible();
    expect(pending.calls.filter(call => call.method === "PUT").map(call => call.path)).toEqual(["/api/uploads/" + alternate.id]);
    await pending.context.close();
  }
  const complete = await open({ saved: record("videos", "complete") });
  await complete.page.getByRole("button", { name: "上传下一个", exact: true }).click();
  await expect(complete.page.locator("#upload-instance")).toBeVisible(); await expect(complete.page.locator("#upload-file")).toHaveCount(1);
  await complete.page.locator("#upload-instance").selectOption("pc_b:main"); expect(complete.calls.filter(call => call.method === "DELETE")).toHaveLength(0); await complete.context.close();
  for (const cancelStatus of [503, 200]) {
    const pending = await open({ saved: record("music"), cancelStatus }); await pending.page.getByRole("button", { name: "取消上传", exact: true }).first().click();
    if (cancelStatus === 503) { await expect(pending.page.getByText("直播电脑离线，尚未下发新任务。", { exact: true }).first()).toBeVisible(); await expect(pending.page.locator("#upload-instance")).toHaveCount(0); await expect(pending.page.getByRole("button", { name: "继续上传", exact: true })).toBeDisabled(); }
    else await expect(pending.page.locator("#upload-instance")).toBeVisible();
    expect(pending.calls.filter(call => call.method === "DELETE")).toHaveLength(1); await pending.context.close();
  }
  for (const [initialKind, recoveredKind] of [["videos", "music"], ["music", "videos"], ["music", "music"]]) {
    const resumed = await open({ recovery: record(recoveredKind) }); const page = resumed.page;
    await page.locator("#upload-kind").selectOption(initialKind);
    const oldFile = initialKind === "music" ? { name: "other.mp3", mimeType: "audio/mpeg" } : { name: "other.mp4", mimeType: "video/mp4" };
    await page.locator("#upload-file").setInputFiles({ ...oldFile, buffer: Buffer.from("old file") });
    await expect(page.getByRole("button", { name: "开始上传", exact: true })).toBeEnabled();
    await page.locator(".upload-recovery summary").click(); await page.getByRole("button", { name: "查询／恢复", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeDisabled();
    await expect(page.locator("#upload-file")).toHaveAttribute("accept", recoveredKind === "music" ? /\.mp3/ : /\.mp4/);
    await expect(page.locator(".upload-progress-meta")).toContainText("50%");
    const original = recoveredKind === "music" ? { name: "original.mp3", mimeType: "audio/mpeg" } : { name: "original.mp4", mimeType: "video/mp4" };
    await page.locator("#upload-file").setInputFiles({ ...original, buffer: Buffer.from("new file") });
    await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeEnabled();
    await page.reload(); await expect(page.locator("#upload-file")).toHaveAttribute("accept", recoveredKind === "music" ? /\.mp3/ : /\.mp4/); await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeDisabled();
    expect(resumed.calls.every(call => call.method === "GET")).toBe(true); await resumed.context.close();
  }
  expect(errors).toEqual([]); console.log("PASS: recovery serializes with resume across video/music/same-kind records; resumed local synthetic transfer reaches the selected original record only; offline completion dismiss and server-confirmed cancellation remain valid. No external upload submitted.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(output) !== os.tmpdir() || !path.basename(output).startsWith("ln-upload-recovery-ui-")) throw new Error("Unsafe cleanup");
  await rm(output, { recursive: true, force: true });
}
