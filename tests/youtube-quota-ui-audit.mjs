/** 浏览器配额审计：挂载真实 useInstance Hook，模拟内部 HTTP，验证重挂载、休眠和卸载后的轮询数量。 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const out = path.resolve(".data/youtube-quota-audit/ui"); await mkdir(out, { recursive: true });
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {useInstance} from './src/app/use-instance'; import {WorkbenchViewContext} from './src/app/components/workbench-context';
window.reads=0; window.externalAttempts=0;
window.fetch=async input=>{const url=new URL(String(input),location.href);if(url.origin!==location.origin){window.externalAttempts++;throw Error('External network forbidden')}
if(url.pathname==='/api/status'){window.reads++;return Response.json({state:{phase:'idle',stage:'Synthetic',selection:{video:'fixture.mp4',music:'fixture.mp3',videoAudio:false}},busy:false,obs:{ready:true,running:true,streaming:false},youtube:{connected:true},media:{videos:['fixture.mp4'],music:['fixture.mp3']},configuration:{missing:[],privacy:'private',madeForKids:false}})}throw Error('Unexpected internal API')};
function Probe(){useInstance({id:'main',name:'Synthetic'});return null}
const root=createRoot(document.getElementById('root'));
window.mount=(count=1,active=true)=>flushSync(()=>root.render(React.createElement(WorkbenchViewContext.Provider,{value:{active,navigation:null}},Array.from({length:count},(_,i)=>React.createElement(Probe,{key:i})))));
window.clear=()=>flushSync(()=>root.render(null)); window.ready=true;
`;
const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx", sourcefile: "quota-ui-audit.tsx" }, bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const server = createServer((request, response) => { response.setHeader("Content-Type", request.url === "/app.js" ? "application/javascript" : "text/html"); response.end(request.url === "/app.js" ? bundle.outputFiles[0].text : '<!doctype html><div id="root"></div><script src="/app.js"></script>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, ...(process.env.QUOTA_AUDIT_BROWSER_CHANNEL ? { channel: process.env.QUOTA_AUDIT_BROWSER_CHANNEL } : {}) });
const results = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.request().url().startsWith(url) ? route.continue() : route.abort());
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  await page.goto(url); await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.mount()); await page.clock.runFor(1); await page.waitForFunction(() => window.reads === 1);
  await page.clock.runFor(10_000); assert.equal(await page.evaluate(() => window.reads), 3);
  results.push({ scenario: "one-active-hook-10s", internalStatusReads: 3 });
  await page.evaluate(() => window.clear()); const stopped = await page.evaluate(() => window.reads);
  await page.clock.runFor(30_000); assert.equal(await page.evaluate(() => window.reads), stopped);
  results.push({ scenario: "unmounted-30s", additionalInternalReads: 0 });
  for (let i = 0; i < 10; i++) { await page.evaluate(() => window.mount()); await page.clock.runFor(1); await page.evaluate(() => window.clear()); }
  const before = await page.evaluate(() => window.reads); await page.clock.runFor(30_000); assert.equal(await page.evaluate(() => window.reads), before);
  results.push({ scenario: "ten-remounts-then-unmounted-30s", additionalInternalReads: 0 });
  await page.evaluate(() => window.mount(1, false)); await page.clock.runFor(1); const hidden = await page.evaluate(() => window.reads);
  await page.clock.runFor(14_999); assert.equal(await page.evaluate(() => window.reads), hidden + 1);
  results.push({ scenario: "inactive-workspace", intervalSeconds: 15 }); await page.evaluate(() => window.clear());
  const multiBefore = await page.evaluate(() => window.reads); await page.evaluate(() => window.mount(20)); await page.clock.runFor(1);
  assert.equal(await page.evaluate(() => window.reads), multiBefore + 20);
  assert.equal(await page.evaluate(() => window.externalAttempts), 0);
  results.push({ scenario: "twenty-same-target-hooks", initialInternalReads: 20, externalRequests: 0 });
  await writeFile(path.join(out, "result.json"), JSON.stringify({ passed: true, cases: results, boundary: "Real Hook and browser timers; mocked internal HTTP. Google request coalescing is verified separately at Service level." }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: results }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
