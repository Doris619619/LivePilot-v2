/** LiveNest 桌面入口：本地静态界面、受限 IPC、托盘与用户确认的退出。 */
import { app, net, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, session, Tray } from "electron";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Manager } from "./manager";
import { DesktopAuth } from "./auth";
import { Shutdown } from "./shutdown";
const auth = new DesktopAuth((url, init) => net.fetch(url, init));
protocol.registerSchemesAsPrivileged([{ scheme: "livenest", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("LiveNest"); app.setAppUserModelId("com.doris619619.livenest");
app.setPath("userData", path.join(app.getPath("appData"), "LiveNest"));
// 开发验收使用独立目录；正式安装不接受环境覆盖生产身份。
if (!app.isPackaged && process.env.LIVENEST_TEST_DATA) app.setPath("userData", path.resolve(process.env.LIVENEST_TEST_DATA));
let window: BrowserWindow | undefined; let tray: Tray | undefined; let quitting = false; let manager: Manager; let shutdown: Shutdown | undefined;
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
/** 只允许静态输出目录中的文件，防止任意路径读取及远程内容拥有桌面权限。 */
async function serve(request: Request) {
  try {
    const url = new URL(request.url); if (url.hostname !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
    const root = path.join(app.getAppPath(), "desktop", "out"); const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filename = path.resolve(root, relative); if (!filename.startsWith(root + path.sep) || relative.includes("\\")) return new Response(null, { status: 403 });
    const bytes = await readFile(filename); const ext = path.extname(filename);
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };
    const hashes = ext === ".html" ? [...bytes.toString().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter(m => m[1]).map(m => "'sha256-" + createHash("sha256").update(m[1]).digest("base64") + "'").join(" ") : "";
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime[ext] || "application/octet-stream", "Content-Security-Policy": "default-src 'self'; script-src 'self' " + hashes + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Not found", { status: 404 }); }
}
/** 验证消息确实来自本地顶层窗口；子框架、远程页面都不能发起系统操作。 */
function trusted(event: Electron.IpcMainInvokeEvent) { const url = new URL(event.senderFrame?.url || "about:blank"); if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || url.protocol !== "livenest:" || url.hostname !== "app") throw new Error("不受信任的桌面请求。"); }
/** 明确退出统一进入本地排空流程；关窗仍维持设备在线，不创建维护锁。 */
async function quit() {
  await shutdown?.request();
}
/** 独立窗口不加载云端站点，使用静态输出及 contextIsolation。 */
async function launch() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "desktop-resources");
  manager = new Manager(resources, () => { quitting = true; }, () => auth.headers());
  shutdown = new Shutdown(manager, {
    /** 明确说明网页控制将离线，默认取消；不把退出解释为停播。 */
    confirm: async () => (await dialog.showMessageBox({ type: "question", title: "退出 LiveNest", message: "退出后网页将无法控制这台电脑。客户端会等待已接收的任务处理完毕；OBS 将保持运行。", buttons: ["取消", "退出"], defaultId: 0, cancelId: 0 })).response === 1,
    /** 排空失败显示可重试说明，不透传底层请求或凭据。 */
    notify: async message => { await dialog.showMessageBox({ type: "warning", title: "暂未退出 LiveNest", message }); },
    /** 只有 Agent 已退出才放行 Electron 生命周期，防止再次弹出退出确认。 */
    finish: () => { quitting = true; app.quit(); },
  });
  await manager.init();
  protocol.handle("livenest", serve); session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1280, height: 880, minWidth: 780, minHeight: 620, show: false, backgroundColor: "#ffffff", title: "LiveNest", autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", e => e.preventDefault()); window.webContents.on("will-attach-webview", e => e.preventDefault());
  window.on("close", e => { if (!quitting) { e.preventDefault(); window?.hide(); } });
  ipcMain.handle("desktop:session", event => { trusted(event); return auth.session(); });
  ipcMain.handle("desktop:login", (event, username, password) => { trusted(event); return auth.login(username, password); });
  ipcMain.handle("desktop:logout", event => { trusted(event); return auth.logout(); });
  ipcMain.handle("desktop:state", async event => { trusted(event); await auth.require(manager.settings.paired ? manager.settings.identity?.agentId : undefined, false); return manager.state(); });
  const action = z.enum(["restore-candidate", "scan", "scan-cancel", "import-obs", "firewall", "diagnose-obs", "check", "prepare", "pair", "start", "add", "rename", "attach", "repair", "repair-managed", "discard", "directory", "open-data", "autostart", "web", "update-check", "update-download", "update-install"]);
  ipcMain.handle("desktop:act", async (event, name, input) => { trusted(event); if (name !== "web") await auth.require(manager.settings.paired ? manager.settings.identity?.agentId : undefined); return manager.act(action.parse(name), input === undefined ? {} : z.record(z.string(), z.unknown()).parse(input)); });
  const image = nativeImage.createFromPath(path.join(resources, "icon.png")); tray = new Tray(image); tray.setToolTip("LiveNest");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 LiveNest", click: () => window?.show() }, { label: "网页工作台", click: () => { void manager.act("web"); } }, { type: "separator" }, { label: "退出", click: () => { void quit(); } }])); tray.on("double-click", () => window?.show());
  await window.loadURL("livenest://app/index.html"); if (!process.argv.includes("--hidden")) window.show();
  const launched = Date.now(); setTimeout(() => { void manager.updates.check(true); }, 30_000).unref(); setInterval(() => { void manager.updates.check(true); }, 6 * 3_600_000).unref();
  /** 焦点与唤醒只在首次启动窗口后触发补查。 */
  const recheck = () => { if (Date.now() - launched >= 30_000) void manager.updates.check(true); }; window.on("focus", recheck); powerMonitor.on("resume", recheck);
}
app.on("second-instance", () => { window?.show(); window?.focus(); });
/** 应用级退出复用托盘确认；更新器已获维护许可时通过 quitting 放行。 */
app.on("before-quit", event => { if (!quitting && shutdown) { event.preventDefault(); void quit(); } });
if (ownsLock) void app.whenReady().then(launch).catch(async error => { quitting = true; await dialog.showMessageBox({ type: "error", message: "LiveNest 未能加载数据。请检查原数据盘与 Windows 账户，原有文件没有删除。", detail: error instanceof Error ? error.message : "请保留原配置并重试。" }); app.quit(); });
