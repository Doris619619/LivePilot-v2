/** LiveNest 桌面入口：本地静态界面、受限 IPC、托盘与用户确认的退出。 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, session, Tray } from "electron";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Manager } from "./manager";
import { DesktopAuth } from "./auth";
const auth = new DesktopAuth();
protocol.registerSchemesAsPrivileged([{ scheme: "livenest", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("LiveNest"); app.setAppUserModelId("com.doris619619.livenest");
app.setPath("userData", path.join(app.getPath("appData"), "LiveNest"));
// 开发验收使用独立目录；正式安装不接受环境覆盖生产身份。
if (!app.isPackaged && process.env.LIVENEST_TEST_DATA) app.setPath("userData", path.resolve(process.env.LIVENEST_TEST_DATA));
let window: BrowserWindow | undefined; let tray: Tray | undefined; let quitting = false; let manager: Manager;
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
/** 只有托盘明确退出才结束 Agent；关窗维持设备在线。 */
async function quit() {
  if (manager.busy) { await dialog.showMessageBox({ message: "配置仍在进行，请完成后退出。" }); return; }
  const answer = await dialog.showMessageBox({ type: "question", title: "退出 LiveNest", message: "退出后网页将无法控制这台电脑。OBS 不会被强行关闭。", buttons: ["取消", "退出"], defaultId: 0, cancelId: 0 });
  if (answer.response !== 1) return;
  try { await manager.maintenance(); await manager.agent.stop(); quitting = true; app.quit(); } catch (e) { await dialog.showMessageBox({ type: "error", message: (e as Error).message }); }
}
/** 独立窗口不加载云端站点，使用静态输出及 contextIsolation。 */
async function launch() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "desktop-resources");
  manager = new Manager(resources, () => { quitting = true; }); await manager.init();
  protocol.handle("livenest", serve); session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1280, height: 880, minWidth: 780, minHeight: 620, show: false, backgroundColor: "#ffffff", title: "LiveNest", autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", e => e.preventDefault()); window.webContents.on("will-attach-webview", e => e.preventDefault());
  window.on("close", e => { if (!quitting) { e.preventDefault(); window?.hide(); } });
  ipcMain.handle("desktop:session", event => { trusted(event); return auth.session(); });
  ipcMain.handle("desktop:login", (event, username, password) => { trusted(event); return auth.login(username, password); });
  ipcMain.handle("desktop:logout", event => { trusted(event); auth.logout(); });
  ipcMain.handle("desktop:state", event => { trusted(event); auth.require(); return manager.state(); });
  const action = z.enum(["check", "prepare", "pair", "start", "add", "rename", "attach", "repair", "repair-managed", "discard", "directory", "open-data", "autostart", "web", "update-check", "update-download", "update-install"]);
  ipcMain.handle("desktop:act", (event, name, input) => { trusted(event); auth.require(); return manager.act(action.parse(name), input === undefined ? {} : z.record(z.string(), z.unknown()).parse(input)); });
  const image = nativeImage.createFromPath(path.join(resources, "icon.png")); tray = new Tray(image); tray.setToolTip("LiveNest");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 LiveNest", click: () => window?.show() }, { label: "网页工作台", click: () => { void manager.act("web"); } }, { type: "separator" }, { label: "退出", click: () => { void quit(); } }])); tray.on("double-click", () => window?.show());
  await window.loadURL("livenest://app/index.html"); if (!process.argv.includes("--hidden")) window.show();
  const launched = Date.now(); setTimeout(() => { void manager.updates.check(true); }, 30_000).unref(); setInterval(() => { void manager.updates.check(true); }, 6 * 3_600_000).unref();
  /** 焦点与唤醒只在首次启动窗口后触发补查。 */
  const recheck = () => { if (Date.now() - launched >= 30_000) void manager.updates.check(true); }; window.on("focus", recheck); powerMonitor.on("resume", recheck);
}
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.on("before-quit", event => { if (!quitting && manager) { event.preventDefault(); window?.show(); } });
if (ownsLock) void app.whenReady().then(launch).catch(async () => { quitting = true; await dialog.showMessageBox({ type: "error", message: "LiveNest 启动失败，请检查配置文件权限或重新安装。原有数据未删除。" }); app.quit(); });
