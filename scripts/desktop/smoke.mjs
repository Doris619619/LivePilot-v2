/** 目录包验收：验证 ASAR 白名单、关键资源、Node 可执行性和最终 Electron fuse。 */
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import asar from "@electron/asar";
import fuses from "@electron/fuses";
const root = path.resolve(process.argv[2] || "release/win-unpacked"); const resources = path.join(root, "resources");
const entries = asar.listPackage(path.join(resources, "app.asar")).map(n => n.replaceAll("\\", "/"));
if (entries.some(n => /(^|[\\/])(\.env[^\\/]*|\.data|identity\.json|builtin-member\.json|settings\.json)([\\/]|$)/.test(n))) throw new Error("Private file included in ASAR");
for (const file of ["agent/desktop-worker.cjs", "vendor/node.exe", "vendor/obs.zip", "icon.png"]) await access(path.join(resources, file));
const manifest = JSON.parse(await readFile(path.join(resources, "vendor/manifest.json"), "utf8"));
for (const [file, expected] of [["obs.zip", manifest.obs.sha256], ["node.exe", manifest.node.sha256]]) if (createHash("sha256").update(await readFile(path.join(resources, "vendor", file))).digest("hex") !== expected) throw new Error("Bundled resource checksum mismatch");
const nodeVersion = execFileSync(path.join(resources, "vendor/node.exe"), ["--version"], { encoding: "utf8", windowsHide: true }).trim(); if (nodeVersion !== "v" + manifest.node.version) throw new Error("Bundled Node version mismatch");
const wire = await fuses.getCurrentFuseWire(path.join(root, "LiveNest.exe")); for (const key of [fuses.FuseV1Options.RunAsNode, fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable, fuses.FuseV1Options.EnableNodeCliInspectArguments]) if (wire[key] !== 48) throw new Error("Unsafe fuse");
if (!entries.some(n => n.endsWith("desktop/out/index.html")) || !entries.some(n => n.endsWith("websocket.png"))) throw new Error("Desktop UI or offline help missing");
console.log("Packaged checks passed: isolated ASAR, resources, Node, offline help and Electron fuses.");
