/** 发布交互回归：合成计划验证页码钳制、翻页清除已放弃草稿和常显阶段播报，不连接设备或外部服务。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "livenest-publishing-guidelines-"));
const plan = createPublishingPreview().view.plans.find(value => !value.confirmedAt);
assert.ok(plan?.items.length);
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import PlanConfirm from './src/app/publishing/plan-confirm'; import BatchExecution from './src/app/publishing/batch-execution';
import './src/app/globals.css'; import './src/app/publishing/publishing.css'; import './src/app/components/ui/ui.css';
const plan=window.syntheticPlan;
const jobs=Array.from({length:26},(_,index)=>({spec:{id:'00000000-0000-4000-8000-'+String(index).padStart(12,'0'),batchId:plan.id,revision:1,desired:'run',profile:{...plan.profile,privacy:'public',scheduled:true},asset:plan.batch.packages[0].sourceVideo,contentPackage:{name:'Video '+(index+1),batchName:plan.batch.name},originalPublishAt:'2030-10-23T12:00:00.000Z'},createdAt:1,observed:{revision:1,state:'scheduled',offset:0,total:1000,updatedAt:1}}));
const privatePlan={...plan,profile:{...plan.profile,privacy:'private',scheduled:false}};
const mode=new URLSearchParams(location.search).get('case');
createRoot(document.getElementById('root')).render(<div className='publishing-shell'>{mode==='private'?<PlanConfirm plan={privatePlan} busy={false} replacements={[]} update={async()=>undefined} confirm={async()=>{}} back={()=>{}} viewHistory={()=>{}}/>:<BatchExecution jobs={jobs} busy={false} operate={async()=>true} onDirtyChange={value=>{window.executionDirty=value}}/>}</div>);`, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", outfile: path.join(temporary, "fixture.js"), jsx: "automatic", alias: { "@": path.join(root, "src") }, logLevel: "silent" });

/** 此服务只提供当前构建的静态夹具，所有 API 与媒体请求均不落到真实系统。 */
async function respond(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (["/fixture.js", "/fixture.css"].includes(pathname)) {
    response.setHeader("content-type", pathname.endsWith(".js") ? "text/javascript" : "text/css");
    response.end(await readFile(path.join(temporary, pathname.slice(1)))); return;
  }
  response.setHeader("content-type", "text/html;charset=utf-8");
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><title>合成发布回归</title><body><div id="root"></div><script>window.syntheticPlan=${JSON.stringify(plan).replaceAll("<", "\\u003c")}</script><script src="/fixture.js"></script></body></html>`);
}
const server = createServer((request, response) => { void respond(request, response); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
const errors = [], checks = [];
try {
  browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", route => route.request().url().startsWith(origin) && !route.request().url().includes("/api/") ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "?case=private&publishing-plan-page=999");
  await expect(page.locator(".publishing-plan-item")).toHaveCount((plan.items.length - 1) % 25 + 1);
  checks.push("超大 URL 页码仍显示最后一页计划内容");

  await page.goto(origin + "?case=jobs");
  const first = page.locator(".publishing-job").first();
  await expect(page.locator(".publishing-job")).toHaveCount(25);
  const announcements = first.locator('[aria-live="polite"]');
  await expect(announcements).toHaveCount(1);
  assert.equal(await announcements.evaluate(element => element.closest("details") === null), true);
  assert.equal(await first.locator("details").getAttribute("open"), null);
  checks.push("折叠详情时主行仍包含唯一阶段播报区域");

  await first.locator("summary").click();
  await first.getByRole("button", { name: "改期", exact: true }).click();
  await first.locator('input[type="datetime-local"]').fill("2030-11-01T18:00");
  await expect.poll(() => page.evaluate(() => window.executionDirty)).toBe(true);
  let dialogs = 0;
  page.on("dialog", async dialog => { dialogs++; await dialog.accept(); });
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Video 26", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.executionDirty)).toBe(false);
  assert.equal(dialogs, 1);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Video 1", exact: true })).toBeVisible();
  await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);
  assert.equal(dialogs, 1);
  checks.push("确认放弃后翻页清除草稿标记，返回原页不复活输入或重复询问");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors, synthetic: true }, null, 2));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(temporary) !== os.tmpdir() || !path.basename(temporary).startsWith("livenest-publishing-guidelines-")) throw new Error("Unsafe temporary cleanup");
  await rm(temporary, { recursive: true, force: true });
}
