/* 文件用途：LiveNest 直播控制台根布局，配置全局元数据、字符集与基础结构。 */

import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./login.css";

// 自托管同一套中英文字形；构建及访问均不需要请求外部字体服务。
const workspaceFont = localFont({ src: "./fonts/livenest-sans-sc.woff2", variable: "--font-livenest", weight: "100 900", display: "swap", fallback: ["Microsoft YaHei UI", "sans-serif"], adjustFontFallback: false });

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
    <html lang="zh-CN" className={workspaceFont.variable}>
      <body>{children}</body>
    </html>
  );
}
