/** 编译 Electron 与独立 Node Agent，所有 npm 依赖入包，不依赖目标电脑 node_modules。 */
import { build } from "esbuild";
const shared = { bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false, logLevel: "info", tsconfig: "tsconfig.json" };
await build({ ...shared, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs", external: ["electron", "bufferutil", "utf-8-validate"] });
await build({ ...shared, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs", external: ["electron"] });
await build({ ...shared, entryPoints: ["src/agent/desktop-worker.ts"], outfile: "desktop-resources/agent/desktop-worker.cjs", external: ["bufferutil", "utf-8-validate"] });
