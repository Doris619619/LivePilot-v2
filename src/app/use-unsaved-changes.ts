/** 未保存表单的会话内离页保护；只保存 dirty 标记，不持久化密钥或表单值。 */
"use client";
import { useEffect, useRef } from "react";

const drafts = new Set<symbol>();
let allowUntil = 0;
let protectedLocation: { href: string; state: unknown; index?: number } | undefined;
let recoveringIndex: number | undefined;
const historyIndexKey = "__livenest_history_index";
type PageNavigationEvent = Event & { destination?: { url: string }; navigationType?: string };
type PageNavigation = EventTarget;

/** 只读取本应用附加的安全整数索引；旧 entry 没有此字段时不能推断遍历方向。 */
function historyIndex(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[historyIndexKey];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** 历史元数据不包含表单；调用方传入的 Next 标记原样保留，但不替普通写入添加内部标记。 */
function indexedState(state: unknown, index: number) {
  return { ...(state && typeof state === "object" ? state : {}), [historyIndexKey]: index };
}

/** 仅旧浏览器从模块加载时标记当前及后续 entry；包装可位于 Next patch 内侧或外侧。 */
function trackHistoryEntries() {
  if ((window as Window & { navigation?: PageNavigation }).navigation) return;
  // window 是 popstate 的 target，同一 target 按注册顺序调用；不能等 dirty 后才排在 Next 之后。
  window.addEventListener("popstate", beforeHistory, true);
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  // 初始化只附加索引，不改变地址或已有 Next 树。
  replace.call(window.history, indexedState(window.history.state, historyIndex(window.history.state) ?? 0), "", window.location.href);
  /** 新 entry 沿当前分支递增，普通 null 状态仍由 Next 自行补齐 canonical URL 所需标记。 */
  window.history.pushState = function pushTrackedState(state, unused, url) {
    push.call(window.history, indexedState(state, (historyIndex(window.history.state) ?? 0) + 1), unused, url);
    if (drafts.size) rememberLocation();
  };
  /** 替换保持当前索引；无索引旧 entry 的安全恢复可显式带回受保护索引。 */
  window.history.replaceState = function replaceTrackedState(state, unused, url) {
    replace.call(window.history, indexedState(state, historyIndex(window.history.state) ?? historyIndex(state) ?? 0), unused, url);
    // 遍历后的 Next 替换可能先于晚加载的监听器；目标 entry 不能覆盖尚未确认离开的原位置。
    if (drafts.size && (protectedLocation?.index === undefined || historyIndex(window.history.state) === protectedLocation.index)) rememberLocation();
  };
}

// 导入时开始记录，保证首次编辑之前创建的 Next/native 同文档历史也有索引。
if (typeof window !== "undefined") trackHistoryEntries();

/** 本地取消、替换或关闭编辑器前确认丢弃；没有修改时不打断正常导航。 */
export function confirmDiscardChanges(dirty: boolean) {
  return !dirty || window.confirm("有未保存的修改，确定放弃这些修改？");
}

/** 设备或账号切换会销毁下层表单，调用方无需读取或持久化其具体草稿内容。 */
export function confirmActiveDrafts() { return confirmDiscardChanges(drafts.size > 0); }

/** 同一项导航只询问一次；后续原生卸载事件不再重复显示另一份警告。 */
function allowNavigation() {
  if (!drafts.size || Date.now() < allowUntil) return true;
  if (!window.confirm("有未保存的修改，确定离开当前页面？")) return false;
  allowUntil = Date.now() + 1500;
  return true;
}

/** 刷新、关闭窗口和完整页面导航使用浏览器原生未保存提示。 */
function beforeUnload(event: BeforeUnloadEvent) {
  if (!drafts.size || Date.now() < allowUntil) return;
  event.preventDefault(); event.returnValue = "";
}

/** Next 站内链接在捕获阶段受保护；新标签和页内定位不销毁当前草稿。 */
function beforeLink(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>("a[href]");
  if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
  const destination = new URL(link.href, window.location.href);
  if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname) return;
  if (!allowNavigation()) { event.preventDefault(); event.stopImmediatePropagation(); }
}

/** 支持 Navigation API 的浏览器也在 SPA 前进后退前确认，不在 popstate 后回滚历史。 */
function beforeNavigation(event: PageNavigationEvent) {
  if (!event.cancelable || event.defaultPrevented || !event.destination) return;
  const destination = new URL(event.destination.url);
  const leavingPage = destination.pathname !== window.location.pathname;
  const restoringQuery = event.navigationType === "traverse" && destination.search !== window.location.search;
  if ((leavingPage || restoringQuery) && !allowNavigation()) event.preventDefault();
}

/** 无 Navigation API 时记录仍持有草稿的地址；自建筛选更新不构成丢弃。 */
function rememberLocation() { protectedLocation = { href: window.location.href, state: window.history.state, index: historyIndex(window.history.state) }; }

/** 取消受控历史跳转时回到原 entry；无索引旧 entry 仅恢复 URL/Next 树，不截断 forward。 */
function beforeHistory(event: PopStateEvent) {
  if (!protectedLocation) return;
  const currentIndex = historyIndex(event.state);
  if (recoveringIndex !== undefined) {
    event.stopImmediatePropagation();
    if (currentIndex === recoveringIndex) { recoveringIndex = undefined; rememberLocation(); }
    else if (currentIndex !== undefined) window.history.go(recoveringIndex - currentIndex);
    else {
      // 恢复过程中遇到模块导入前的旧 entry，不猜测方向或覆盖 forward 历史。
      recoveringIndex = undefined;
      window.history.replaceState(protectedLocation.state, "", protectedLocation.href);
      rememberLocation();
    }
    return;
  }
  const previous = new URL(protectedLocation.href), current = new URL(window.location.href);
  if ((previous.pathname !== current.pathname || previous.search !== current.search) && !allowNavigation()) {
    event.stopImmediatePropagation();
    if (currentIndex !== undefined && protectedLocation.index !== undefined && currentIndex !== protectedLocation.index) {
      recoveringIndex = protectedLocation.index;
      window.history.go(recoveringIndex - currentIndex);
    } else {
      // 旧 entry 无法可靠定位原位置；replace 保留当前表单和全部 forward 分支。
      window.history.replaceState(protectedLocation.state, "", protectedLocation.href);
      rememberLocation();
    }
    return;
  }
  rememberLocation();
}

/** dirty 时启用离页拦截并共享一次提示；旧浏览器常驻 popstate 监听在没有草稿时不处理事件。 */
export function useUnsavedChanges(dirty: boolean) {
  const token = useRef(Symbol("draft"));
  useEffect(() => {
    if (!dirty) return;
    const id = token.current;
    const navigation = (window as Window & { navigation?: PageNavigation }).navigation;
    if (!drafts.size) {
      window.addEventListener("beforeunload", beforeUnload);
      document.addEventListener("click", beforeLink, true);
      navigation?.addEventListener("navigate", beforeNavigation);
      if (!navigation) { rememberLocation(); window.addEventListener("livenest-query-changed", rememberLocation); }
    }
    drafts.add(id);
    return () => {
      drafts.delete(id);
      if (!drafts.size) {
        window.removeEventListener("beforeunload", beforeUnload);
        document.removeEventListener("click", beforeLink, true);
        navigation?.removeEventListener("navigate", beforeNavigation);
        if (!navigation) { window.removeEventListener("livenest-query-changed", rememberLocation); protectedLocation = undefined; recoveringIndex = undefined; }
        allowUntil = 0;
      }
    };
  }, [dirty]);
}
