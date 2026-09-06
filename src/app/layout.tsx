import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "LivePilot — 直播控制台", description: "本机 OBS + YouTube 直播控制台" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
