/** 桌面根布局直接共用 LiveNest 网站字体和样式，断网仍可显示。 */
import localFont from "next/font/local";
import "../../src/app/globals.css";
import "../../src/app/login.css";
import "./desktop.css";
import "../../src/app/components/ui/ui.css";
import "../../src/app/workspace-refresh.css";
const font = localFont({ src: "../../src/app/fonts/livenest-sans-sc.woff2", variable: "--font-livenest", weight: "100 900", display: "swap", adjustFontFallback: false });
/** 本地配置界面不加载网页登录页及云端服务代码。 */
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN" className={font.variable}><body>{children}</body></html>; }
