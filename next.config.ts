import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  logging: false,
  serverExternalPackages: ["obs-websocket-js"],
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
