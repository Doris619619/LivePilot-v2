/** 前端预览回归：真实播放合成文件，校验媒体生命周期、混音、响应式和零业务请求。 */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const origin = process.env.LIVEPILOT_UI_ORIGIN || "http://127.0.0.1:3021";
const output = path.resolve(".data/media-preview-ui"); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.LIVEPILOT_UI_BROWSER || "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = []; const requests = []; const checks = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/api/**", route => { requests.push(new URL(route.request().url()).pathname); return route.abort(); });
await page.addInitScript(() => {
  window.previewRevoked = []; const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { window.previewRevoked.push(url); revoke(url); };
});
/** 所有播放器断言等待实际媒体状态，不用固定延时猜测已开始。 */
async function ready() { await page.waitForFunction(() => [...document.querySelectorAll("video")].some(v => v.getClientRects().length && v.readyState >= 2 && v.duration === 12)); }
/** 切换后旧元素必须暂停且清除 src，才能认为关闭已释放媒体请求。 */
async function stopped(handle) { assert.equal(await handle.evaluate(v => v.paused && !v.getAttribute("src")), true); await handle.dispose(); }
try {
  await page.goto(origin + "/preview"); await ready();
  assert.equal(await page.locator("video:visible").evaluate(v => v.paused), true);
  await page.screenshot({ path: path.join(output, "desktop-content.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "播放预览", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("video").currentTime > 0.25);
  await page.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(await page.locator("video:visible").evaluate(v => v.muted), true);
  assert.equal(await page.getByText("播放器已静音，不能据此判断素材没有声音。").isVisible(), true);
  const old = await page.locator("video:visible").elementHandle();
  await page.getByRole("button", { name: "发布效果", exact: true }).click(); await stopped(old); await ready();
  await page.getByRole("button", { name: "播放预览", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector("video").paused && !document.querySelector("audio").paused);
  assert.equal(await page.locator("video:visible").evaluate(v => v.muted && v.loop), true);
  await page.getByLabel("保留视频原声").check(); await ready();
  assert.equal(await page.locator("video:visible").evaluate(v => v.paused && !v.muted), true);
  checks.push("source playback, mute feedback, live original-audio toggle, source switch stops old media");

  await page.getByRole("button", { name: "视频发布", exact: true }).click(); await ready();
  await page.getByRole("button", { name: "发布效果", exact: true }).click(); await ready();
  await page.getByRole("button", { name: "播放预览", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.getByRole("button", { name: "暂停预览", exact: true }).click();
  await page.getByRole("slider", { name: "播放进度" }).fill("7");
  await page.waitForFunction(() => Math.abs(document.querySelector("video").currentTime - 7) < .2 && Math.abs(document.querySelector("audio").currentTime - 3) < .3);
  assert.equal(await page.locator("video:visible").evaluate(v => v.muted && !v.loop), true);
  await page.getByRole("slider", { name: "播放进度" }).fill("11.8");
  await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").currentTime >= 11.7);
  await page.getByRole("button", { name: "播放预览", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("video").ended && document.querySelector("audio").paused);
  checks.push("publishing music replaces source, seeks modulo music duration, stops with video");

  await page.getByLabel("测试素材").selectOption("noaudio"); await ready();
  assert.equal(await page.getByText("原视频没有音轨", { exact: true }).isVisible(), true);
  await page.getByLabel("测试素材").selectOption("silent"); await ready();
  assert.equal(await page.getByText("采样片段疑似静音，建议试听核对", { exact: true }).isVisible(), true);
  await page.getByLabel("测试素材").selectOption("broken");
  await page.getByText(/视频无法在浏览器中播放.*尚未判定文件损坏/).waitFor();
  await page.getByLabel("选择本地视频").setInputFiles(path.resolve("public/preview/normal.mp4")); await ready();
  assert.equal(await page.getByText("音轨尚未检测，请播放确认声音", { exact: true }).isVisible(), true);
  const localUrl = await page.locator("video:visible").getAttribute("src"); assert.match(localUrl, /^blob:/);
  await page.getByLabel("测试素材").selectOption("normal"); await ready();
  assert.equal(await page.evaluate(url => window.previewRevoked.includes(url), localUrl), true);
  checks.push("absent/silent sample labels, decode failure, local real metadata, object URL revoked");

  await page.getByRole("tab", { name: "预览封面／标题" }).click();
  const longTitle = "山间晨雾与宁静时光".repeat(15);
  await page.getByRole("textbox", { name: "标题", exact: true }).fill(longTitle);
  assert.equal(await page.locator("article h4").innerText(), longTitle);
  await page.screenshot({ path: path.join(output, "desktop-cover-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "桌面端", exact: true }).click();
  await page.screenshot({ path: path.join(output, "desktop-cover-wide.png"), fullPage: true, animations: "disabled" });
  assert.equal(await page.locator("video").count(), 0);
  checks.push("live title binding, mobile/desktop cards, tab change unmounts media");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "预览", exact: true }).click(); await ready();
  const dialog = page.getByRole("dialog"); const bounds = await dialog.boundingBox();
  assert.ok(bounds.width >= 388 && bounds.height >= 840);
  await page.getByRole("button", { name: "播放预览", exact: true }).first().click();
  const mobileVideo = await page.locator("video:visible").elementHandle();
  await page.screenshot({ path: path.join(output, "mobile-preview.png"), fullPage: false, animations: "disabled" });
  await page.keyboard.press("Escape"); await stopped(mobileVideo);
  assert.equal(await page.getByRole("textbox", { name: "标题", exact: true }).inputValue(), longTitle);
  await page.waitForFunction(() => document.activeElement?.textContent === "预览");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push("mobile fullscreen, Escape stops media, title retained, focus restored, no horizontal overflow");
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  checks.push("zero business API calls and zero uncaught browser errors");
  await writeFile(path.join(output, "report.json"), JSON.stringify({ origin, checks, errors, requests }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  await writeFile(path.join(output, "failure.json"), JSON.stringify({ message: error.message, errors, requests, media: await page.locator("video,audio").evaluateAll(elements => elements.map(el => ({ tag: el.tagName, time: el.currentTime, duration: el.duration, paused: el.paused, ended: el.ended, ready: el.readyState, seeking: el.seeking, error: el.error?.code }))) }, null, 2));
  throw error;
} finally { await browser.close(); }
