/** 下载固定官方 OBS/Node，验证摘要并准备离线资源；缓存命中仍校验。 */
import { mkdir, readFile, writeFile, copyFile, cp, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { icon } from "./icon.mjs";
const root = path.resolve("desktop-resources"); const vendor = path.join(root, "vendor"); await mkdir(vendor, { recursive: true });
/** 下载只来自脚本内固定官方 HTTPS 地址；curl 错误不会被当作成功文件。 */
function fetchFile(url, file) { execFileSync("curl.exe", ["--fail", "--location", "--retry", "3", "--connect-timeout", "20", "--max-time", "900", "--output", file, url], { windowsHide: true, stdio: "inherit" }); }
/** 摘要不匹配即拒绝构建，不回退到未校验文件。 */
async function verified(file, expected) { try { return createHash("sha256").update(await readFile(file)).digest("hex") === expected; } catch { return false; } }
const obsHash = "4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1";
const obsLicense = path.join(vendor, "OBS-COPYING.txt");
if (!await access(obsLicense).then(() => true, () => false)) fetchFile("https://raw.githubusercontent.com/obsproject/obs-studio/32.2.2/COPYING", obsLicense);
const obs = path.join(vendor, "obs.zip");
if (!await verified(obs, obsHash)) fetchFile("https://github.com/obsproject/obs-studio/releases/download/32.2.2/OBS-Studio-32.2.2-Windows-x64.zip", obs);
if (!await verified(obs, obsHash)) throw new Error("OBS SHA256 mismatch");
const nodeVersion = "22.23.1"; const nodeArchive = `node-v${nodeVersion}-win-x64.zip`; const shas = path.join(vendor, "SHASUMS256.txt");
if (!await access(shas).then(() => true, () => false)) fetchFile(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, shas);
const nodeHash = (await readFile(shas, "utf8")).split(/\r?\n/).find(l => l.endsWith("  " + nodeArchive))?.split(/\s+/)[0];
if (!nodeHash || !/^[a-f0-9]{64}$/.test(nodeHash)) throw new Error("Official Node checksum missing");
const zip = path.join(vendor, nodeArchive); if (!await verified(zip, nodeHash)) fetchFile(`https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`, zip);
if (!await verified(zip, nodeHash)) throw new Error("Node SHA256 mismatch");
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LN_NODE_ZIP -DestinationPath $env:LN_VENDOR -Force"], { env: { ...process.env, LN_NODE_ZIP: zip, LN_VENDOR: vendor }, windowsHide: true, stdio: "inherit" });
await copyFile(path.join(vendor, `node-v${nodeVersion}-win-x64/node.exe`), path.join(vendor, "node.exe"));
await copyFile(path.join(vendor, `node-v${nodeVersion}-win-x64/LICENSE`), path.join(vendor, "NODE-LICENSE.txt"));
await writeFile(path.join(vendor, "manifest.json"), JSON.stringify({ obs: { version: "32.2.2", sha256: obsHash }, node: { version: nodeVersion, archiveSha256: nodeHash, sha256: createHash("sha256").update(await readFile(path.join(vendor, "node.exe"))).digest("hex") } }, null, 2));
await mkdir("desktop/public/help", { recursive: true }); await cp("docs/images/obs-setup", "desktop/public/help", { recursive: true }); await icon(root);
await writeFile(path.join(root, "THIRD-PARTY.txt"), "OBS Studio 32.2.2: GPL-2.0-or-later. Corresponding source: https://github.com/obsproject/obs-studio/archive/refs/tags/32.2.2.zip\nNode.js " + nodeVersion + ": see vendor/NODE-LICENSE.txt\nElectron: see LICENSE.electron.txt and LICENSES.chromium.html\nNoto Sans SC: SIL OFL-1.1, see FONT-OFL.txt\n");
await copyFile("src/app/fonts/OFL.txt", path.join(root, "FONT-OFL.txt")).catch(async () => { const names = await import("node:fs/promises").then(fs => fs.readdir("src/app/fonts")); const name = names.find(n => /ofl|license/i.test(n)); if (!name) throw new Error("Font license missing"); await copyFile(path.join("src/app/fonts", name), path.join(root, "FONT-OFL.txt")); });
console.log("Verified OBS, Node and offline help resources.");
