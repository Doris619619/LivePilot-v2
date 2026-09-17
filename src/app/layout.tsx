/* 文件用途：LiveNest 直播控制台根布局，配置全局元数据、字符集与基础结构。 */

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LiveNest — 多频道广播控制台",
  description: "LiveNest 现代专业直播发射台，支持多电脑 OBS 实例与 YouTube 频道独立编排调度",
};

/**
 * 根布局组件，为全站提供统一的基础 HTML 容器。
 *
 * @param props 包含子节点的组件属性
 * @returns 包含 HTML 与 Body 的根节点
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
