/** 真实 HTTP、独立 Agent 与 FFmpeg 验收；只用隔离目录和合成素材，不连接 OBS/YouTube。 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";
const serve = process.argv.includes("--serve");
const base = path.resolve(".data/media-preview-integration"); await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-")); const cloudRoot = path.join(root, "cloud"); const agentRoot = path.join(root, "agent"); const publishing = path.join(agentRoot, "Publishing");
const bundle = path.join(root, "runtime.cjs");
await build({ entryPoints: ["tests/support/media-preview-browser.tsx"], bundle: true, platform: "browser", jsx: "automatic", format: "iife", outfile: path.join(root, "browser.js"), logLevel: "silent" });
await build({ entryPoints: ["tests/support/media-preview-runtime.ts"], bundle: true, platform: "node", packages: "external", alias: { "server-only": path.resolve("tests/server-only.ts") }, logLevel: "silent", format: "cjs", outfile: bundle });
const runtime = (await import(pathToFileURL(bundle).href)).default;
let origin = ""; let agent; let browser; let previewPlan;
const checks = []; const requests = [];
/** 实际路由的 HTTP 适配支持背压和客户端取消，不模拟预览响应。 */
const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController(); outgoing.on("close", () => { if (!outgoing.writableFinished) abort.abort(); });
  try {
    const url = new URL(incoming.url, origin); requests.push(url.pathname);
    if (url.pathname === "/") { outgoing.setHeader("content-type", "text/html; charset=utf-8"); outgoing.setHeader("set-cookie", runtime.access.SESSION_COOKIE + "=" + login + "; HttpOnly; SameSite=Strict; Path=/"); outgoing.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离设备素材预览</title><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/browser.css"><style>body{padding:32px}main{max-width:1000px;margin:0 auto}.ui-dialog{max-width:850px}</style><div id="root"></div><script>window.previewPlan=' + JSON.stringify(previewPlan).replaceAll("<", "\\u003c") + '</script><script src="/browser.js"></script>'); return; }
    if (["/browser.js", "/browser.css", "/globals.css"].includes(url.pathname)) { outgoing.setHeader("content-type", url.pathname.endsWith("js") ? "text/javascript" : "text/css"); outgoing.end(await readFile(url.pathname === "/globals.css" ? path.resolve("src/app/globals.css") : path.join(root, url.pathname.slice(1)))); return; }
    const request = new Request(url, { method: incoming.method, headers: incoming.headers, signal: abort.signal, ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: "half" } : {}) });
    const response = url.pathname.startsWith("/api/agent/") ? await runtime.agent[incoming.method](request, { params: Promise.resolve({ path: url.pathname.slice(11).split("/") }) }) : await runtime.browser[incoming.method](request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing); else outgoing.end();
  } catch { outgoing.destroy(); }
});
await new Promise(resolve => { server.once("error", error => { throw error; }); server.listen(serve ? 3031 : 0, "127.0.0.1", resolve); }); origin = "http://127.0.0.1:" + server.address().port;
Object.assign(process.env, { LIVEPILOT_DATA_ROOT: cloudRoot, LIVEPILOT_ACCESS_DIR: path.join(cloudRoot, "access"), LIVEPILOT_MODE: "cloud", LIVEPILOT_ORIGIN: origin, LIVEPILOT_ENCRYPTION_KEY: randomBytes(32).toString("hex") });
const token = randomBytes(32).toString("hex"); const login = randomBytes(32).toString("hex");
const state = runtime.access.emptyAccess(); state.users.push({ username: "tester", salt: "fixture", hash: "fixture", revision: "1", disabled: false }); state.sessions[runtime.access.digest(login)] = { username: "tester", revision: "1", expires: Date.now() + 3600_000 }; await runtime.access.accessStore().write("access.json", state);
const bootId = randomUUID();
const pairing = await runtime.agents.createPairing("preview_test", "Isolated preview", "tester"); await runtime.agents.pairAgent("preview_test", pairing.code, token, undefined, "tester");
await runtime.agents.openSession("preview_test", bootId, [{ id: "main", name: "Isolated preview" }]); await runtime.agents.agentStore("preview_test").write("capabilities.json", ["publishing-accounts-v1"]);
const account = await runtime.accounts.createPublishingAccount({ username: "tester", role: "customer" }, "preview_test", "main", "Synthetic channel");
await runtime.accounts.claimPublishingAccount("preview_test", account.id, "main", "test_channel", "Synthetic channel", false, Date.now()); await runtime.accounts.claimPublishingAccount("preview_test", account.id, "main", "test_channel", "Synthetic channel", true, Date.now());
for (const sample of ["normal", "noaudio", "silent", "broken"]) { const folder = path.join(publishing, "Inbox", "Batch", sample); await mkdir(folder, { recursive: true }); await copyFile(path.resolve("public/preview/" + sample + ".mp4"), path.join(folder, "video.mp4")); if (sample === "normal") await copyFile(path.resolve("public/preview/music.m4a"), path.join(folder, "music.m4a")); }
const sourceBytes = await readFile("public/preview/normal.mp4");
for (const sample of ["truncated", "middle", "long", "unsupported"]) await mkdir(path.join(publishing, "Inbox", "Batch", sample), { recursive: true });
await writeFile(path.join(publishing, "Inbox", "Batch", "truncated", "video.mp4"), sourceBytes.subarray(0, Math.floor(sourceBytes.length / 2)));
const corrupt = Buffer.from(sourceBytes); corrupt.fill(0xff, Math.floor(corrupt.length / 2), Math.floor(corrupt.length / 2) + 10000); await writeFile(path.join(publishing, "Inbox", "Batch", "middle", "video.mp4"), corrupt);
await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-stream_loop", "49", "-i", path.resolve("public/preview/normal.mp4"), "-c", "copy", path.join(publishing, "Inbox", "Batch", "long", "video.mp4")], { windowsHide: true });
await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", path.resolve("public/preview/normal.mp4"), "-c:v", "ffv1", "-an", path.join(publishing, "Inbox", "Batch", "unsupported", "video.mkv")], { windowsHide: true });
await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", path.resolve("public/preview/normal.mp4"), "-frames:v", "1", path.join(publishing, "Inbox", "Batch", "normal", "cover.png")], { windowsHide: true });
const packages = (await runtime.packages.scanPublishingPackages(publishing)).batches[0].packages.sort((a, b) => a.name === "normal" ? -1 : b.name === "normal" ? 1 : a.name.localeCompare(b.name));
const destination = { agentId: "preview_test", instanceId: "main", accountId: account.id, channelId: "test_channel" };
previewPlan = createPublishingPreview().view.plans.find(plan => !plan.confirmedAt);
previewPlan.profile = { ...previewPlan.profile, ...destination, thumbnailMode: "matching" };
previewPlan.batch.packages = packages; previewPlan.items = packages.map(pkg => ({ packageId: pkg.id, excluded: false, scheduleSource: "auto" })); previewPlan.copies = packages.map(pkg => ({ packageId: pkg.id, title: "已配置标题 · " + pkg.name, description: "隔离测试" }));
/** HTTP 请求使用真实 Cookie 与同源保护，测试凭据不进入报告。 */
async function post(value) { const response = await fetch(origin + "/api/media-preview", { method: "POST", headers: { cookie: runtime.access.SESSION_COOKIE + "=" + login, origin, "x-livepilot": "1", "content-type": "application/json" }, body: JSON.stringify(value) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; }
/** 等待真实检查结束，不依据播放开头判断完整。 */
async function settled(id) { for (let n = 0; n < 150; n++) { const result = await post({ action: "status", id }); if (!result.busy) return result; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error("Check did not complete"); }
/** 返回完整媒体 Response，便于校验 Range 字节和错误。 */
async function media(id, part, range) { return fetch(`${origin}/api/media-preview?id=${id}&part=${part}`, { headers: { cookie: runtime.access.SESSION_COOKIE + "=" + login, ...(range ? { range } : {}) } }); }
try {
  agent = spawn(process.execPath, [bundle, "worker"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, LIVEPILOT_MODE: "agent", LIVEPILOT_DATA_ROOT: agentRoot, LIVEPILOT_PUBLISHING_ROOT: publishing } });
  const ready = new Promise((resolve, reject) => { agent.on("message", msg => { if (msg.ready) resolve(); if (msg.failed) reject(new Error("Isolated Agent failed: " + msg.reason)); }); agent.once("exit", code => reject(new Error("Isolated Agent exited: " + code))); }); agent.send({ origin, agentId: destination.agentId, accountId: account.id, token, bootId }); await ready;
  if (serve) { console.log("Isolated preview ready: " + origin); await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); }); process.exitCode = 0; }
  else {
  let normal;
  for (const pkg of packages) {
    const opened = await post({ action: "open", selection: { ...destination, source: { kind: "package", packageId: pkg.id, version: pkg.version } } }); const result = await settled(opened.id);
    if (["broken", "middle", "truncated"].includes(pkg.name)) assert.equal(result.files.video.check.state, "failed", pkg.name);
    else { assert.equal(result.files.video.check.state, "complete", JSON.stringify(result)); assert.ok(Math.abs(result.files.video.duration - (pkg.name === "long" ? 600 : 12)) < 2); assert.equal(result.files.video.check.sound, pkg.name === "silent" ? "suspected-silent" : ["noaudio", "unsupported"].includes(pkg.name) ? "absent" : "present"); }
    if (pkg.name === "long") { await post({ action: "check", id: opened.id }); await post({ action: "cancel", id: opened.id }); const cancelled = await settled(opened.id); assert.equal(cancelled.files.video.check.state, "cancelled"); checks.push("actual long-file decode cancellation and measured duration without arbitrary length warnings"); }
    checks.push(pkg.name + ": actual ffprobe/FFmpeg checks"); if (pkg.name === "normal") normal = result; else await post({ action: "close", id: opened.id });
  }
  const raw = await readFile(path.join(publishing, "Inbox", "Batch", "normal", "video.mp4")); const part = await media(normal.id, "video", "bytes=11-40"); assert.equal(part.status, 206); assert.deepEqual(Buffer.from(await part.arrayBuffer()), raw.subarray(11, 41)); assert.equal((await media(normal.id, "video", "bytes=999999999-")).status, 416); checks.push("real outbound Range exact bytes and invalid range rejection");
  browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" }); const context = await browser.newContext(); await context.addCookies([{ name: runtime.access.SESSION_COOKIE, value: login, url: origin }]); const page = await context.newPage(); await page.goto(origin);
  await page.getByRole("button", { name: "预览视频", exact: true }).click(); await page.getByLabel("视频", { exact: true }).selectOption(packages.find(pkg => pkg.name === "normal").id);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2); await page.getByRole("button", { name: "点击画面播放", exact: true }).click(); await page.waitForFunction(() => document.querySelector("video").currentTime > .2); await page.getByRole("button", { name: "点击画面暂停", exact: true }).click(); await page.getByRole("slider", { name: "播放进度" }).fill("8"); await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").currentTime >= 8);
  assert.equal(await page.getByRole("textbox").count(), 0); assert.equal(await page.getByText("选择本地视频", { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "预览封面／标题" }).click(); await page.getByText("查看完整标题").click(); assert.ok(await page.getByText("已配置标题 · normal", { exact: true }).count());
  await page.waitForFunction(() => document.querySelector('img[alt="当前封面展示示意"]')?.naturalWidth > 0);
  await page.screenshot({ path: path.join(base, "configured-plan.png"), fullPage: true }); await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "预览视频", exact: true }).click(); await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2); await page.waitForFunction(() => !document.querySelector('button[disabled]')?.textContent?.includes("完整检查")); await page.screenshot({ path: path.join(base, "mobile.png"), fullPage: true, animations: "disabled" });
  const bounds = await page.getByRole("dialog").boundingBox(); assert.ok(bounds.width >= 389);
  await page.getByLabel("视频", { exact: true }).selectOption(packages.find(pkg => pkg.name === "unsupported").id); await page.waitForFunction(() => !!document.querySelector("video")?.error); await page.getByRole("alert").filter({ hasText: "浏览器" }).waitFor(); checks.push("browser-incompatible codec is distinguished from successful Agent decode");
  await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector("video"));
  checks.push("configured plan UI plays and seeks actual Agent video, inherits metadata, closes mobile media"); await browser.close(); browser = undefined;
  await post({ action: "check", id: normal.id }); const complete = await settled(normal.id); assert.equal(complete.files.video.check.coverage, "full"); assert.equal(complete.files.video.check.state, "complete"); checks.push("full video/audio decode with explicit coverage");
  await post({ action: "prepare", id: normal.id }); const final = await settled(normal.id); assert.ok(final.files.final, JSON.stringify(final)); assert.equal(final.files.final.duration, 12); const rendered = Buffer.from(await (await media(normal.id, "final")).arrayBuffer());
  const normalPkg = packages.find(p => p.name === "normal"); const cached = JSON.parse(await readFile(path.join(publishing, "Working", "Batch", "normal", normalPkg.version, "render.json"), "utf8")); assert.equal(createHash("sha256").update(rendered).digest("hex"), cached.upload.sha256);
  const version = final.files.final.version; await post({ action: "prepare", id: normal.id }); assert.equal((await settled(normal.id)).files.final.version, version); checks.push("prepared file hash matches upload cache; repeat preparation reuses same version");
  await writeFile(path.join(publishing, "Inbox", "Batch", "normal", "video.mp4"), "replaced"); assert.equal((await media(normal.id, "video")).status, 409); checks.push("file replacement invalidates preview before byte delivery");
  assert.ok(!requests.some(url => /youtube|control|uploads|publishing\/quota/.test(url))); checks.push("zero YouTube/upload/broadcast API calls");
  const stopped = new Promise(resolve => agent.on("message", msg => { if (msg.stopped) { assert.equal(msg.uploads, 0); resolve(); } })); agent.send({ stop: true }); await stopped;
  await writeFile(path.join(base, "report.json"), JSON.stringify({ checks, root, platform: "HTTP route handlers and separate preview Agent; synthetic channel; no OAuth" }, null, 2)); console.log(JSON.stringify({ passed: checks.length, checks }));
  }
} finally { await browser?.close(); agent?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
