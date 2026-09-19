/** Node 回归测试隔离 mock 调用记录，兼容 Vitest 4 的恢复语义。 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({ resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "tests/server-only.ts") } }, test: { environment: "node", restoreMocks: true, clearMocks: true, maxWorkers: 2 } });
