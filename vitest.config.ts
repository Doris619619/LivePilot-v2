import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({ resolve: { alias: { "@": resolve(__dirname, "src"), "server-only": resolve(__dirname, "tests/server-only.ts") } }, test: { environment: "node", restoreMocks: true } });
