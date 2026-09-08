/** 安全响应头与服务端打包边界；运行时素材、密钥和账号不得进入构建产物。 */
import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingExcludes: { "/*": ["./.data/**/*", "./.env*", "./**/.uploads/**/*"] },
  logging: false,
  serverExternalPackages: ["obs-websocket-js"],
  /** 默认禁止缓存敏感页面与接口，并防止嵌入其他站点。 */
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
    ] }];
  },
};
export default config;
