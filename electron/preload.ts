/** 只向受信任本地页面提供状态读取和白名单操作，不暴露 Node 或原始 IPC。 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../src/shared/desktop";
const bridge: DesktopBridge = { session: () => ipcRenderer.invoke("desktop:session"), login: (username, password) => ipcRenderer.invoke("desktop:login", username, password), logout: () => ipcRenderer.invoke("desktop:logout"), state: () => ipcRenderer.invoke("desktop:state"), act: (action, input) => ipcRenderer.invoke("desktop:act", action, input) };
contextBridge.exposeInMainWorld("liveNest", bridge);
