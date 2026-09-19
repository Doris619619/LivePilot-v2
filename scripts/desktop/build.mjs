/** 桌面构建调度：静态页面、内置运行时、目录预览、NSIS 与受控 CI 发布。 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { icon } from "./icon.mjs";
import { validateRelease, publish } from "./publish.mjs";
const mode = process.argv[2]; if (!["renderer", "preview", "package", "release"].includes(mode)) throw new Error("Choose renderer, preview, package or release");
if (mode === "release") await validateRelease();
/** 传递参数数组，不经过命令 shell。 */
function node(...args) { execFileSync(process.execPath, args, { stdio: "inherit", windowsHide: true }); }
await mkdir("desktop/public/help", { recursive: true }); await cp("docs/images/obs-setup", "desktop/public/help", { recursive: true }); await icon("desktop-resources");
if (mode !== "renderer") node("scripts/desktop/resources.mjs");
node("node_modules/next/dist/bin/next", "build", "desktop", "--webpack");
if (mode !== "renderer") {
  node("scripts/desktop/compile.mjs");
  const pkg = JSON.parse(await readFile("package.json", "utf8")); const stage = "build/desktop-app";
  await mkdir(stage, { recursive: true }); await cp("dist-electron", stage + "/dist-electron", { recursive: true }); await cp("desktop/out", stage + "/desktop/out", { recursive: true });
  await writeFile(stage + "/package.json", JSON.stringify({ name: "livenest", version: pkg.version, description: "LiveNest Windows 直播设备配置客户端", author: "LiveNest", main: "dist-electron/main.cjs" }, null, 2));
  node("node_modules/electron-builder/cli.js", "--config", "electron-builder.config.cjs", "--win", ...(mode === "preview" ? ["--dir", "--config.directories.output=release/preview"] : []), "--publish", "never");
  const output = mode === "preview" ? "release/preview" : "release";
  const names = (await readdir(output)).filter(n => /\.exe$|\.blockmap$|latest\.yml$/.test(n)); const artifacts = [];
  for (const name of names) { const bytes = await readFile(path.join(output, name)); artifacts.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
  const commit = execFileSync("git", ["-c", "safe.directory=" + process.cwd().replaceAll("\\", "/"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-c", "safe.directory=" + process.cwd().replaceAll("\\", "/"), "status", "--porcelain"], { encoding: "utf8" }).trim();
  await writeFile(output + "/build-manifest.json", JSON.stringify({ version: pkg.version, commit, workingTree: dirty ? "dirty" : "clean", mode, createdAt: new Date().toISOString(), artifacts }, null, 2));
  node("scripts/desktop/smoke.mjs", output + "/win-unpacked");
  if (mode === "release") await publish();
}
