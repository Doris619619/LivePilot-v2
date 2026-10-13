/** 浏览器本地文件预览：Object URL 仅存在于当前页面，替换或关闭后释放，不上传文件。 */
"use client";
import { useEffect, useRef, useState } from "react";

/** 文件变化即撤销旧 URL；返回值绑定文件身份，避免短暂播放上一份素材。 */
export function useLocalMedia() {
  const [resource, setResource] = useState<{ file: File; url: string }>();
  const owned = useRef(new Set<string>());
  useEffect(() => {
    const urls = owned.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, []);
  /** 文件选择事件中创建资源；旧文件立即撤销，取消选择保留现有预览。 */
  function select(file?: File) {
    if (!file) return;
    for (const url of owned.current) URL.revokeObjectURL(url);
    owned.current.clear();
    const url = URL.createObjectURL(file); owned.current.add(url); setResource({ file, url });
  }
  return [resource, select] as const;
}

/** 未取得有效媒体时长时显示待读取，而不是把未知值当成零秒。 */
export function mediaTime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "待读取";
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].filter((_, index) => total >= 3600 || index > 0).map(value => String(value).padStart(2, "0")).join(":");
}
