/** 浏览器查询状态：保留其他筛选和 hash，以可订阅的 History 更新支持刷新、分享和前进后退。 */
"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

const changed = "livenest-query-changed";
type QueryUpdates = Record<string, string | number | undefined>;
type NavigationEvents = EventTarget;

/** History API 与浏览器前后退共用订阅；Next 的原生 History 集成不需要重建工作区。 */
function subscribe(listener: () => void) {
  const navigation = (window as Window & { navigation?: NavigationEvents }).navigation;
  window.addEventListener("popstate", listener);
  window.addEventListener(changed, listener);
  navigation?.addEventListener("currententrychange", listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(changed, listener); navigation?.removeEventListener("currententrychange", listener); };
}
/** 快照是稳定字符串；服务端先用默认值，水合后再恢复浏览器地址中的筛选。 */
function snapshot() { return window.location.pathname + window.location.search + window.location.hash; }
/** 服务端不读取浏览器全局，避免静态页面构建和水合不一致。 */
function serverSnapshot() { return ""; }

/** 无效或缺失的 URL 值退回调用方默认值；自定义解析器负责字段白名单。 */
export function readUrlValue<T>(href: string, key: string, initial: T, parse?: (raw: string) => T): T {
  const raw = new URL(href || "/", "http://localhost").searchParams.get(key);
  if (raw === null) return initial;
  try { return parse ? parse(raw) : typeof initial === "number" ? (Number.isFinite(Number(raw)) ? Number(raw) : initial) as T : raw as T; }
  catch { return initial; }
}

/** 一次只替换指定字段，其他查询参数、路由和锚点保持不变。 */
export function mergeUrlValues(href: string, updates: QueryUpdates, pathname?: string) {
  const url = new URL(href || "/", "http://localhost");
  if (pathname) url.pathname = pathname;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search + url.hash;
}

/** 受控状态从 URL 读取；连续 setter 每次读取最新地址，避免同一事件丢失其他字段。 */
export function useUrlState<T>(key: string, initial: T, parse?: (raw: string) => T, serialize?: (value: T) => string, historyMode: "push" | "replace" = "push"): [T, Dispatch<SetStateAction<T>>] {
  const href = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const value = readUrlValue(href, key, initial, parse);
  const configuration = useRef({ initial, parse, serialize });
  useEffect(() => { configuration.current = { initial, parse, serialize }; }, [initial, parse, serialize]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    const { initial: fallback, parse: decode, serialize: encode } = configuration.current;
    const current = readUrlValue(window.location.href, key, fallback, decode);
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(current) : next;
    const encoded = encode ? encode(resolved) : String(resolved);
    const defaultValue = encode ? encode(fallback) : String(fallback);
    const destination = mergeUrlValues(window.location.href, { [key]: encoded === defaultValue ? undefined : encoded });
    if (destination === snapshot()) return;
    // Next 自行复制内部历史标记；传入 __NA 会跳过它对 canonical URL 的同步。
    window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", destination);
    window.dispatchEvent(new Event(changed));
  }, [key, historyMode]);
  return [value, setValue];
}

/** 提供真实 href 以保留复制链接、新标签与中键行为；组件仍可对普通点击使用自己的 setter。 */
export function useUrlHref(updates: QueryUpdates, pathname?: string) {
  const href = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return mergeUrlValues(href, updates, pathname);
}
