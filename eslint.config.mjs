/** ESLint 源码检查；运行数据和生成的 Agent 包不参与。 */
import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";
export default defineConfig([...next, ...ts, globalIgnores(["dist/**", "dist-electron/**", "build/**", "release/**", "desktop-resources/**", "desktop/.next/**", "desktop/out/**", "desktop/next-env.d.ts", ".next/**", ".data/**", "coverage/**", "next-env.d.ts"])]);
