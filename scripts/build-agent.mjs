/** 将独立 Agent 和设备管理 CLI 打包为 Node 程序，禁止引入 Next.js 运行时。 */
import { build } from "esbuild";
/** Node 包内仅保留 Node/OBS 等服务端依赖，无浏览器入口。 */
await build({ entryPoints: { agent: "src/agent/main.ts", "agent-admin": "src/cloud/admin.ts" }, outdir: "dist", bundle: true, platform: "node", target: "node22", format: "cjs", outExtension: { ".js": ".cjs" }, packages: "external", sourcemap: false, logLevel: "info" });
