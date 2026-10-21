/** 真实React数据台双标签恢复：合成本地政策CAS、脏草稿、过期明细和合并次数，无外部请求。 */
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
const output = path.resolve(".data/youtube-policy-recovery-ui"); await mkdir(output, { recursive: true });
const now = Date.parse("2026-10-21T19:00:00Z");
const summary = { project: "synthetic-project", day: "2026-10-21", costVersion: "synthetic", policyRevision: 0, policy: { providerDailyUnits: 10000, dailyUnits: 9000, controlReserve: 500, sendUnits: 2000, streamUnits: 500, backgroundUnits: 2000, unitsPerMinute: 30, burstUnits: 60, searchesPerDay: 100, uploadsPerDay: 100 }, baseline: { known: true, units: 0, uploads: 0 }, usedUnits: 1, uploads: 0, reservedUnits: 0, remainingUnits: 8999, byPurpose: {}, byMethod: {}, coverage: { protected: 0, total: 0, devices: [] }, totals: { attempts: 1, failures: 0, cacheHits: 120, blocked: 0 }, ranking: [], minutes: [], lastSyncedAt: now, incomplete: false, droppedEvents: 0 };
const events = { events: [{ eventId: "synthetic-count", at: now, agentId: "synthetic_device", instanceId: "main", method: "channels.list", purpose: "background", trigger: "dashboard", kind: "decision", decision: "cache", count: 120, estimatedUnits: null }], detailsAvailableFrom: now - 14 * 86400_000, expired: true, incomplete: true, droppedEvents: 0 };
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Usage from './src/app/admin/youtube-usage'; import './src/app/globals.css'; import './src/app/admin/admin.css'; createRoot(document.getElementById('root')).render(<Usage active timeZone="America/New_York"/>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, platform: "browser", format: "iife", outfile: path.join(output, "app.js"), jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent" });
let puts = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/admin/youtube-usage")) {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "PUT") {
      let body = ""; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body); puts++;
      if (value.policyRevision !== summary.policyRevision) { response.statusCode = 409; response.end(JSON.stringify({ error: "配额政策版本已变化，请刷新并核对最新预算后再保存；当前草稿已保留。" })); return; }
      summary.policy = value.policy; summary.policyRevision++; summary.remainingUnits = summary.policy.dailyUnits - summary.usedUnits;
    }
    response.end(JSON.stringify(url.pathname.endsWith("/events") ? events : summary)); return;
  }
  const name = request.url === "/app.js" ? "app.js" : request.url === "/app.css" ? "app.css" : undefined;
  response.setHeader("Content-Type", name?.endsWith("js") ? "text/javascript" : name ? "text/css" : "text/html");
  response.end(name ? await readFile(path.join(output, name)) : '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><main class="main-wrapper admin-page"><div id="root"></div></main><script src="/app.js"></script></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = "http://127.0.0.1:" + server.address().port;
let browser; const errors = [];
try {
  browser = await chromium.launch({ headless: true, channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const a = await context.newPage(), b = await context.newPage();
  for (const page of [a, b]) { page.on("pageerror", error => errors.push(error.message)); await page.clock.install({ time: new Date(now) }); await page.goto(origin); await page.getByRole("button", { name: "保护设置", exact: true }).click(); await page.getByText("配额政策与当日基线", { exact: true }).click(); await expect(page.getByLabel("通用每日预算", { exact: true })).toHaveValue("9000"); }
  await a.getByLabel("通用每日预算", { exact: true }).fill("6000"); await a.getByRole("button", { name: "保存配额政策", exact: true }).click(); await expect(a.getByText("已保存。新的请求按此预算准入。", { exact: true })).toBeVisible();
  await b.getByRole("button", { name: "刷新记录", exact: true }).click(); await expect(b.getByLabel("通用每日预算", { exact: true })).toHaveValue("6000");
  await b.getByLabel("后台状态上限", { exact: true }).fill("1000"); await b.getByRole("button", { name: "保存配额政策", exact: true }).click(); await expect(b.getByText("已保存。新的请求按此预算准入。", { exact: true })).toBeVisible(); expect(summary.policy.dailyUnits).toBe(6000); expect(summary.policy.backgroundUnits).toBe(1000);
  await b.getByLabel("后台状态上限", { exact: true }).fill("1100");
  await a.getByRole("button", { name: "刷新记录", exact: true }).click(); await expect(a.getByLabel("后台状态上限", { exact: true })).toHaveValue("1000"); await a.getByLabel("通用每日预算", { exact: true }).fill("7000"); await a.getByRole("button", { name: "保存配额政策", exact: true }).click(); await expect(a.getByLabel("通用每日预算", { exact: true })).toHaveValue("7000");
  await b.getByRole("button", { name: "刷新记录", exact: true }).click(); await expect(b.getByText(/其他标签或管理员已更新政策/)).toBeVisible(); await expect(b.getByLabel("后台状态上限", { exact: true })).toHaveValue("1100"); await expect(b.getByLabel("通用每日预算", { exact: true })).toHaveValue("6000");
  await b.getByRole("button", { name: "保存配额政策", exact: true }).click(); await expect(b.getByText(/配额政策版本已变化/)).toBeVisible(); expect(summary.policy.dailyUnits).toBe(7000); expect(summary.policy.backgroundUnits).toBe(1000); await expect(b.getByLabel("后台状态上限", { exact: true })).toHaveValue("1100");
  await b.screenshot({ path: path.join(output, "dirty-conflict-desktop.png"), fullPage: true });
  await b.getByRole("button", { name: "载入最新政策并放弃草稿", exact: true }).click(); await expect(b.getByLabel("通用每日预算", { exact: true })).toHaveValue("7000"); await expect(b.getByLabel("后台状态上限", { exact: true })).toHaveValue("1000");
  await b.getByRole("button", { name: "用量与日志", exact: true }).click(); await expect(b.getByText("合并 120 次", { exact: true })).toBeVisible(); await expect(b.getByText(/所选范围包含已过14天保留期的明细/)).toBeVisible();
  events.events = []; await b.getByRole("button", { name: "刷新记录", exact: true }).click(); await expect(b.getByText("保留期内无匹配明细，较早明细已过期。", { exact: true })).toBeVisible();
  await b.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await b.screenshot({ path: path.join(output, "expired-mobile.png"), fullPage: true });
  expect(puts).toBe(4); expect(errors).toEqual([]); console.log("PASS: two real React tabs synchronize clean drafts, preserve dirty drafts through refresh and409, explicitly discard on reload; expired empty ranges and merged120 counts remain visible; no external requests.");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
