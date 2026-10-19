/** 执行机窗口缩放快捷键：只拦截当前窗口的 Ctrl 缩放组合，不接触 Agent 或持久化配置。 */
import type { Input, WebContents } from "electron";

const zoomFactors = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const zoomTolerance = 0.0001;
type ZoomAction = "in" | "out" | "reset";

/** 只识别 Ctrl 缩放按下事件；保留组合输入、其他系统快捷键及数字键盘的 Insert 行为。 */
function zoomAction(input: Input): ZoomAction | undefined {
  if (input.type !== "keyDown" || !input.control || input.alt || input.meta || input.isComposing) return;
  if (input.key === "+" || input.key === "=" || input.key === "Add" || input.code === "NumpadAdd") return "in";
  if (input.key === "-" || input.key === "Subtract" || input.code === "NumpadSubtract") return "out";
  if (input.key === "0") return "reset";
}

/** 沿浏览器常用比例逐档调整并限制在 50%–200%；容忍 Chromium 比例读数的浮点误差。 */
function nextZoomFactor(current: number, action: Exclude<ZoomAction, "reset">): number {
  if (action === "in") return zoomFactors.find(factor => factor > current + zoomTolerance) ?? zoomFactors[zoomFactors.length - 1];
  return [...zoomFactors].reverse().find(factor => factor < current - zoomTolerance) ?? zoomFactors[0];
}

/** 为指定窗口安装缩放键；先阻止页面及菜单再次处理，再由主进程改变整页显示比例。 */
export function installWindowZoom(webContents: Pick<WebContents, "on" | "getZoomFactor" | "setZoomFactor">): void {
  /** 只消费已识别的缩放组合，其他按键继续交给当前输入框、页面和菜单。 */
  webContents.on("before-input-event", (event, input) => {
    const action = zoomAction(input);
    if (!action) return;
    event.preventDefault();
    webContents.setZoomFactor(action === "reset" ? 1 : nextZoomFactor(webContents.getZoomFactor(), action));
  });
}
