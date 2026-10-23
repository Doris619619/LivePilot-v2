/** 界面回归：直接打包本次源码组件，以合成数据核对危险操作、输入、草稿、焦点、URL 和窄窗布局。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";
import { createPublishingPreview } from "../scripts/preview/publishing.mjs";
import { agents, dashboard } from "../scripts/preview/fixtures.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "livenest-interface-"));
const output = path.resolve(process.env.WEB_GUIDELINES_SCREENSHOTS || path.join(repo, ".data/interface-guidelines"));
await mkdir(output, { recursive: true });
const plan = createPublishingPreview().view.plans.find(item => !item.confirmedAt);
const instance = { ...agents[0].instances[0], agentId: agents[0].id, agentName: "合成演示电脑" };
const live = dashboard(agents[0], agents[0].instances[0]);
live.device = { agentId: agents[0].id, name: instance.agentName, online: true, lastSeen: Date.now(), observedAt: Date.now() };
Object.assign(live.state, { phase: "live", stage: "合成直播状态", broadcastId: "synthetic", broadcastTitle: "合成直播", selection: { ...live.state.selection, broadcast: { title: "合成直播", description: "界面回归示例", privacy: "public", madeForKids: false, playlistIds: [] } } });
Object.assign(live.obs, { streaming: true, durationMs: 10000 });
Object.assign(live.youtube, { lifecycle: "live", ingest: "active", checkedAt: new Date().toISOString(), query: "ok" });
const source = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import ProfileEditor from './src/app/publishing/profile-editor';
import LiveChatPreview from './src/app/components/live-chat-preview';
import {WeeklySchedule} from './src/app/publishing/package-setup';
import PlanConfirm from './src/app/publishing/plan-confirm';
import UploadRecovery from './src/app/upload-recovery';
import Accounts from './src/app/admin/accounts';
import YouTubeUsage from './src/app/admin/youtube-usage';
import ApiKeySettings from './src/app/components/api-key-settings';
import InstanceConsole from './src/app/instance-console';
import PublishingProfileSettings from './src/app/components/publishing-profile-settings';
import ObsSetupList from './desktop/app/obs-setup-list';
import {defaultLiveChatConfig} from './src/shared/live-chat';
import {useUrlState,useUrlHref} from './src/app/use-url-state';
import {useUnsavedChanges} from './src/app/use-unsaved-changes';
import './src/app/globals.css';import './src/app/components/ui/ui.css';import './src/app/publishing/publishing.css';import './desktop/app/desktop.css';
/** 合成表单只用于验证 URL 连续更新与浏览器历史，不接触真实工作区。 */
function UrlExample(){const [view,setView]=useUrlState('view','live');const [page,setPage]=useUrlState('page',0);const href=useUrlHref({view:'history'});return <><button onClick={()=>{setView('history');setPage(3)}}>切换并分页</button><a href={href}>历史链接</a><output aria-label='URL状态'>{view+':'+page}</output></>}
/** 离页测试只保留一个内存字符串，确保原生提示和 SPA 链接都能取消。 */
function DraftExample(){const [value,setValue]=useState('');const [panel,setPanel]=useUrlState('draft-panel','first');useUnsavedChanges(!!value);return <><label>未保存草稿<input value={value} onChange={e=>setValue(e.target.value)}/></label><button onClick={()=>setPanel(panel==='first'?'second':'first')}>切换查询上下文</button><a href='/leave'>离开当前页</a></>}
/** 各场景直接使用实际组件；所有设备、场次、账户和 API 都是合成示例。 */
function Fixture(){const [rule,setRule]=useState({timezone:'Asia/Shanghai',startDate:'2026-10-23',weeklySlots:[{weekday:1,time:'18:00'},{weekday:1,time:'20:00'}],preuploadDays:28});const which=new URLSearchParams(location.search).get('case');
if(which==='tags')return <ProfileEditor initial={window.auditPlan.profile} busy={false} save={async value=>{window.savedProfile=value}} cancel={()=>{}}/>;
if(which==='chat'||which==='compact')return <LiveChatPreview config={defaultLiveChatConfig} instanceId='audit' agentId='synthetic' compact={which==='compact'}/>;
if(which==='schedule')return <WeeklySchedule rule={rule} change={setRule}/>;
if(which==='plan')return <div className='publishing-shell'><PlanConfirm plan={window.auditPlan} busy={false} replacements={[]} update={async()=>window.auditPlan} confirm={async()=>{}} back={()=>{}} viewHistory={()=>{}}/></div>;
if(which==='upload')return <UploadRecovery agentId='synthetic' instanceId='audit' destinationLabel='合成演示电脑 / OBS 1' restore={()=>{}} cancelled={()=>{}} acquire={()=>({current:()=>true,release:()=>{}})}/>;
if(which==='accounts')return <Accounts/>;
if(which==='quota')return <YouTubeUsage active={true} timeZone='America/New_York'/>;
if(which==='key')return <ApiKeySettings onSaving={()=>{}}/>;
if(which==='stop')return <InstanceConsole instance={window.auditInstance} onChannelChange={()=>{}} onUpload={()=>{}}/>;
if(which==='profileFocus')return <PublishingProfileSettings onSaving={()=>{}}/>;
if(which==='longDesktop')return <main className='main-wrapper'><ObsSetupList state={{instances:[{id:'long_name',name:'W'.repeat(80),initialized:true}],checks:[],candidates:[],paired:false}} snapshots={[]} now={Date.now()} online={false} busy={false} selected='none' onSelect={()=>{}} act={async()=>false} controls={()=>null} checks={()=>null} settings={()=>null} additions={null} connection={()=>null} feedback={null}/></main>;
if(which==='url')return <UrlExample/>;if(which==='draft')return <DraftExample/>;return null;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({ stdin: { contents: source, resolveDir: repo, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: path.join(temporary, "components.js"), tsconfig: path.join(repo, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/components.css"><title>合成数据 · 界面回归</title><body><p role="note">合成数据 · 未连接真实 Agent、OBS、YouTube 或 AI</p><div id="root"></div><script>window.auditInstance=${JSON.stringify(instance)};window.auditPlan=${JSON.stringify(plan).replaceAll("<", "\\u003c")}</script><script src="/components.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (["/components.js", "/components.css"].includes(pathname)) { response.setHeader("content-type", pathname.endsWith(".css") ? "text/css" : "text/javascript"); response.end(await readFile(path.join(temporary, pathname.slice(1)))); }
  else { response.setHeader("content-type", "text/html;charset=utf-8"); response.end(html); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 保留未包装入口，仅用于构造模块导入前没有本应用索引的旧历史场景。
await context.addInitScript(() => { window.fixtureNativeHistory = { pushState: history.pushState.bind(history), replaceState: history.replaceState.bind(history) }; });
const requests = [], errors = [], checks = [], dialogs = [];
let acceptDialog = true;
const policy = { providerDailyUnits: 10000, dailyUnits: 9000, controlReserve: 500, sendUnits: 2000, streamUnits: 500, backgroundUnits: 2000, unitsPerMinute: 30, burstUnits: 60, searchesPerDay: 100, uploadsPerDay: 100 };
const summary = { project: "synthetic", day: "2026-10-23", costVersion: "synthetic", policy, policyRevision: 0, baseline: { known: true, units: 0, uploads: 0 }, usedUnits: 0, uploads: 0, reservedUnits: 0, remainingUnits: 9000, byPurpose: {}, byMethod: {}, coverage: { protected: 0, total: 0, devices: [] }, totals: { attempts: 0, failures: 0, cacheHits: 0, blocked: 0 }, ranking: [], minutes: [], incomplete: false, droppedEvents: 0 };
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith("/api/")) return route.continue();
  requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
  if (url.pathname === "/api/live-chat") return route.fulfill({ json: { action: "reply", reply: "合成示例回复", reason: "conversation" } });
  if (url.pathname === "/api/media-preview") return route.fulfill({ status: 409, json: { error: "合成界面审查不连接真实媒体" } });
  if (url.pathname === "/api/status") return route.fulfill({ json: live });
  if (url.pathname === "/api/control") return route.fulfill({ status: 409, json: { error: "隔离回归拒绝真实控制命令" } });
  if (["/api/broadcast-profiles", "/api/publishing-templates"].includes(url.pathname)) return route.fulfill({ json: { profiles: [] } });
  if (url.pathname === "/api/uploads") return route.fulfill({ json: [{ id: "synthetic-upload", agentId: "synthetic", instanceId: "audit", filename: "合成示例.mp4", message: "已暂停的合成上传" }] });
  if (url.pathname === "/api/admin/accounts" && request.method() === "GET") return route.fulfill({ json: { accounts: [] } });
  if (url.pathname === "/api/admin/accounts") return route.fulfill({ status: 409, json: { problem: { version: 1, source: "cloud", code: "ACCOUNT_EXISTS", domain: "account", target: {}, severity: "error", stage: "创建合成账号", outcome: "rejected", observedAt: Date.now(), message: "合成示例：账号已存在", actions: [] } } });
  if (url.pathname === "/api/admin/youtube-usage") return route.fulfill({ json: { ...summary, day: url.searchParams.get("day") || summary.day } });
  if (url.pathname === "/api/admin/youtube-usage/events") return route.fulfill({ json: { events: [], incomplete: false, droppedEvents: 0, detailsAvailableFrom: 0, expired: false } });
  if (url.pathname === "/api/account-ai") return route.fulfill({ json: { revision: 0, configured: true, managed: false, uses: { copy: true, chat: true } } });
  return route.fulfill({ json: { ok: true } });
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("dialog", dialog => { dialogs.push(dialog.type()); return acceptDialog ? dialog.accept() : dialog.dismiss(); });
page.on("pageerror", error => errors.push(error.message));
/** 等待 React 事件与一次布局稳定；不使用固定延时判断请求是否发生。 */
async function settled() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
/** 记录实际通过的场景名，失败时保留已完成项与浏览器错误供核对。 */
function passed(name) { checks.push(name); }
try {
  await page.goto(origin + "/?case=tags"); const tags = page.getByRole("textbox", { name: "标签 · 逗号分隔" }); await tags.fill(""); await tags.pressSequentially("lofi,jazz"); await expect(tags).toHaveValue("lofi,jazz"); passed("F03 标签分隔符可逐字输入");
  for (const mode of ["chat", "compact"]) { await page.goto(origin + "/?case=" + mode); const input = page.getByRole("textbox", { name: mode === "chat" ? "模拟观众留言" : "观众留言", exact: true }); await input.fill("输入法候选文本"); const before = requests.length; await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }); await settled(); assert.equal(requests.length, before); await expect(input).toHaveValue("输入法候选文本"); await input.press("Enter"); await page.getByText("合成示例回复", { exact: false }).waitFor(); passed("F04 " + mode + " 输入法确认不发送，正常 Enter 可发送"); }
  await page.goto(origin + "/?case=schedule"); const time = page.getByRole("textbox", { name: "周一发布时间", exact: true }); await time.focus(); await time.fill("21:00"); await expect(time).toHaveValue("21:00"); await expect(page.getByRole("textbox", { name: "周一发布时间 2", exact: true })).toHaveValue("20:00"); await expect(time).toBeFocused(); passed("F05 排期编辑保留逻辑时间槽和焦点");
  await page.goto(origin + "/?case=plan"); await page.getByRole("button", { name: "列表", exact: true }).click(); await page.getByRole("button", { name: /^编辑发布包 / }).first().click(); const title = page.getByRole("textbox", { name: "标题", exact: true }); await title.fill("尚未保存的修改"); acceptDialog = false; await page.keyboard.press("Escape"); await expect(title).toHaveValue("尚未保存的修改"); await page.screenshot({ path: path.join(output, "plan-draft-desktop.png"), fullPage: true, animations: "disabled" }); acceptDialog = true; await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); passed("F06 关闭确认可取消并保留编辑草稿");
  await page.goto(origin + "/?case=upload"); await page.locator("summary").click(); await page.getByText("合成示例.mp4", { exact: true }).waitFor(); const beforeDelete = requests.filter(item => item.method === "DELETE").length; acceptDialog = false; await page.getByRole("button", { name: "取消上传", exact: true }).click(); await settled(); assert.equal(requests.filter(item => item.method === "DELETE").length, beforeDelete); acceptDialog = true; await page.getByRole("button", { name: "取消上传", exact: true }).click(); await expect.poll(() => requests.filter(item => item.method === "DELETE").length).toBe(beforeDelete + 1); passed("F02 取消上传必须确认，取消确认不发送 DELETE");
  await page.goto(origin + "/?case=quota"); await page.getByRole("button", { name: "保护设置", exact: true }).click(); await page.locator("summary").filter({ hasText: "配额政策与当日基线" }).click(); const units = page.getByRole("spinbutton", { name: "Google 通用每日配额", exact: true }); await units.fill("100"); assert.equal(await units.evaluate(node => node.checkValidity()), false); await units.fill("20000"); await page.getByRole("spinbutton", { name: "此前已用通用 units", exact: true }).fill("777"); const day = page.getByLabel("配额日", { exact: true }); const originalDay = await day.inputValue(), nextDay = originalDay === "2026-10-20" ? "2026-10-19" : "2026-10-20"; await Promise.all([page.waitForResponse(response => response.url().includes("/api/admin/youtube-usage?day=" + nextDay)), day.fill(nextDay)]); await page.getByRole("heading", { name: nextDay + " 已用基线", exact: true }).waitFor(); await expect(units).toHaveValue("20000"); await Promise.all([page.waitForResponse(response => response.url().includes("/api/admin/youtube-usage?day=" + originalDay)), day.fill(originalDay)]); await page.getByRole("heading", { name: originalDay + " 已用基线", exact: true }).waitFor(); await expect(page.getByRole("spinbutton", { name: "此前已用通用 units", exact: true })).toHaveValue("777"); passed("F08/F09 配额约束对齐、跨日保留政策及各日基线草稿");
  await units.fill("10000"); const budget = page.getByRole("spinbutton", { name: "通用每日预算", exact: true }); await budget.fill("9999"); await page.getByRole("button", { name: "保存配额政策", exact: true }).click(); await expect(budget).toHaveAttribute("aria-invalid", "true"); await expect(budget).toBeFocused(); passed("F09 预算关系校验就地关联中文错误并聚焦");
  await page.goto(origin + "/?case=accounts"); const account = page.getByRole("textbox", { name: "账号", exact: true }); await account.fill("auditUser"); await page.getByLabel("初始密码", { exact: true }).fill("synthetic-password"); await page.getByLabel("再次输入密码", { exact: true }).fill("synthetic-password"); await page.getByRole("button", { name: "创建客户账号", exact: true }).click(); await expect(account).toHaveAttribute("aria-invalid", "true"); await expect(account).toBeFocused(); passed("F10 API 账号错误聚焦可编辑字段");
  await page.goto(origin + "/?case=key"); const key = page.getByLabel("更换 API Key", { exact: true }); await key.fill("abc"); await page.getByRole("button", { name: "保存设置", exact: true }).click(); await expect(key).toHaveAttribute("aria-invalid", "true"); await expect(key).toBeFocused(); passed("F11 无效密钥关联错误并聚焦");
  await page.goto(origin + "/?case=stop"); await page.getByRole("tab", { name: "开播", exact: true }).click(); const stopCount = () => requests.filter(item => item.path === "/api/control" && item.body?.action === "stop").length; const beforeStop = stopCount(); acceptDialog = false; await page.getByRole("button", { name: "结束直播", exact: true }).click(); await settled(); assert.equal(stopCount(), beforeStop); acceptDialog = true; await page.getByRole("button", { name: "结束直播", exact: true }).click(); await expect.poll(stopCount).toBe(beforeStop + 1); passed("F01 停播确认可取消，确认后只发送一次");
  await page.goto(origin + "/?case=profileFocus"); await page.getByRole("button", { name: "新建视频发布配置包", exact: true }).click(); await page.getByRole("textbox", { name: "配置名称", exact: true }).waitFor(); assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY"); await page.getByRole("button", { name: "返回", exact: true }).click(); await expect(page.getByRole("button", { name: "新建视频发布配置包", exact: true })).toBeFocused(); passed("F12 新建与返回保留有意义的键盘焦点");
  await page.setViewportSize({ width: 780, height: 900 }); await page.goto(origin + "/?case=longDesktop"); await page.getByRole("heading", { name: "W".repeat(80), exact: true }).waitFor(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(output, "desktop-long-name-780.png"), fullPage: true, animations: "disabled" }); await page.setViewportSize({ width: 390, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(output, "desktop-long-name-390.png"), fullPage: true, animations: "disabled" }); passed("F17 长名称在 780/390px 保留状态且无横向溢出");
  await page.goto(origin + "/?case=url&customer=synthetic#details"); await page.getByRole("button", { name: "切换并分页", exact: true }).click(); await expect(page.getByLabel("URL状态")).toHaveText("history:3"); assert.equal(new URL(page.url()).searchParams.get("customer"), "synthetic"); assert.equal(new URL(page.url()).hash, "#details"); await page.reload(); await expect(page.getByLabel("URL状态")).toHaveText("history:3"); await page.goBack(); await expect(page.getByLabel("URL状态")).toHaveText("history:0"); passed("F13/F14 连续 URL 更新、刷新和后退恢复状态");
  await page.goto(origin + "/?case=draft"); await page.getByRole("textbox", { name: "未保存草稿", exact: true }).fill("保留草稿"); acceptDialog = false; await page.getByRole("link", { name: "离开当前页", exact: true }).click(); await expect(page.getByRole("textbox", { name: "未保存草稿", exact: true })).toHaveValue("保留草稿"); acceptDialog = true; await page.getByRole("link", { name: "离开当前页", exact: true }).click(); await expect(page).toHaveURL(origin + "/leave"); passed("F07 站内离页可取消并保留草稿");
  for (const fallback of [false, true]) {
    if (fallback) await page.addInitScript(() => Object.defineProperty(window, "navigation", { configurable: true, value: undefined }));
    await page.goto(origin + "/?case=draft"); await page.getByRole("textbox", { name: "未保存草稿", exact: true }).fill("后退仍要保留"); await page.getByRole("button", { name: "切换查询上下文", exact: true }).click(); const retained = page.url(), dialogCount = dialogs.length; acceptDialog = false; await page.evaluate(() => window.history.back()); await expect.poll(() => dialogs.length).toBe(dialogCount + 1); await expect(page).toHaveURL(retained); await expect(page.getByRole("textbox", { name: "未保存草稿", exact: true })).toHaveValue("后退仍要保留"); acceptDialog = true;
    passed("F06/F07 同页后退可取消并保留草稿" + (fallback ? "（无 Navigation API）" : "（Navigation API）"));
  }
  for (const legacy of [false, true]) {
    await page.goto(origin + "/?case=draft&history-step=0");
    const draft = page.getByRole("textbox", { name: "未保存草稿", exact: true });
    await draft.waitFor();
    await page.evaluate(async oldEntries => {
      const writer = oldEntries ? window.fixtureNativeHistory : history;
      writer.replaceState({ fixtureEntry: "zero" }, "", "?case=draft&history-step=0");
      for (const [step, name] of [[1, "one"], [2, "two"], [3, "three"]]) writer.pushState({ fixtureEntry: name }, "", "?case=draft&history-step=" + step);
      await new Promise(resolve => { addEventListener("popstate", resolve, { once: true }); history.back(); });
    }, legacy);
    await expect(page).toHaveURL(origin + "/?case=draft&history-step=2");
    await draft.fill("取消后退应保留前进历史"); await settled();
    const count = dialogs.length; acceptDialog = false;
    await page.evaluate(() => history.back());
    await expect.poll(() => dialogs.length).toBe(count + 1);
    await expect(page).toHaveURL(origin + "/?case=draft&history-step=2");
    await expect(draft).toHaveValue("取消后退应保留前进历史");
    assert.equal(await page.evaluate(() => history.state.fixtureEntry), "two");
    // 无索引旧 entry 只恢复地址，当前位置可能比原 entry 早一项；已有 forward 分支必须仍可到达。
    acceptDialog = true; await page.evaluate(oldEntries => history.go(oldEntries ? 2 : 1), legacy);
    await expect(page).toHaveURL(origin + "/?case=draft&history-step=3");
    assert.equal(await page.evaluate(() => history.state.fixtureEntry), "three");
    await expect(draft).toHaveValue("取消后退应保留前进历史");
    if (!legacy) {
      await draft.fill(""); await settled(); await draft.fill("多步后退也回原entry"); await settled();
      const previous = dialogs.length; acceptDialog = false;
      await page.evaluate(() => history.go(-2));
      await expect.poll(() => dialogs.length).toBe(previous + 1);
      await expect(page).toHaveURL(origin + "/?case=draft&history-step=3");
      assert.equal(await page.evaluate(() => history.state.fixtureEntry), "three");
      acceptDialog = true;
    }
    passed("F07 取消历史跳转保留 forward 分支" + (legacy ? "（无索引旧entry安全恢复）" : "（受控entry及多步后退）"));
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify({ environment: "synthetic components; all APIs intercepted; no real broadcast/OAuth/AI", checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors }, null, 2));
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  if (!temporary.startsWith(path.resolve(os.tmpdir()) + path.sep + "livenest-interface-")) throw new Error("Unexpected temporary directory");
  await rm(temporary, { recursive: true, force: true });
}
