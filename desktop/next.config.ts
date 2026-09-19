/** 独立静态桌面入口，共享网站组件但不导出云端 API。 */
import type { NextConfig } from "next";
const config: NextConfig = { output: "export", poweredByHeader: false, images: { unoptimized: true }, turbopack: { root: process.cwd() } };
export default config;
