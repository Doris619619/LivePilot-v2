/** 复制 Threadline 的草稿上传、回下载校验、公开发布流程，目标为独立安装包仓库。 */
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
const repository = "Doris619619/LiveNest-Releases";
/** GitHub Token 只通过 CI 环境传入，不出现在命令行或客户端。 */
function gh(args) { return execFileSync("gh", args, { encoding: "utf8", windowsHide: true }); }
/** 本地构建不能发布，版本必须匹配源码仓库的稳定 tag。 */
export async function validateRelease() {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "Doris619619/LivePilot-v2" || process.env.GITHUB_REF !== "refs/tags/v" + version || !/^\d+\.\d+\.\d+$/.test(version) || !process.env.GH_TOKEN) throw new Error("Release requires matching stable tag and release-repository token in source CI");
  return version;
}
/** 已公开版本不覆盖；草稿失败可重试，三项更新资产全部匹配才公开。 */
export async function publish() {
  const version = await validateRelease(); const tag = "v" + version;
  const manifest = JSON.parse(await readFile("release/build-manifest.json", "utf8")); if (manifest.workingTree !== "clean" || manifest.commit !== process.env.GITHUB_SHA) throw new Error("Release must use clean tagged commit");
  const names = [`LiveNest_${version}_x64-setup.exe`, `LiveNest_${version}_x64-setup.exe.blockmap`, "latest.yml"];
  const yaml = await readFile("release/latest.yml", "utf8"); const installer = await readFile("release/" + names[0]);
  if (!yaml.includes("version: " + version) || !yaml.includes(names[0]) || !yaml.includes(createHash("sha512").update(installer).digest("base64"))) throw new Error("Updater metadata mismatch");
  for (const name of names) if (manifest.artifacts.find(a => a.name === name)?.sha256 !== createHash("sha256").update(await readFile("release/" + name)).digest("hex")) throw new Error("Build artifact changed");
  let existing; try { existing = JSON.parse(gh(["release", "view", tag, "--repo", repository, "--json", "isDraft"])); } catch { /* 创建时会明确报告认证失败。 */ }
  if (existing && !existing.isDraft) throw new Error("Published version is immutable");
  if (!existing) gh(["release", "create", tag, "--repo", repository, "--draft", "--title", "LiveNest " + version, "--notes", "Windows x64 安装版。安装后打开设备配置，完成 OBS 与网页配对。"]);
  gh(["release", "upload", tag, "--repo", repository, "--clobber", ...names.map(n => "release/" + n)]);
  const downloaded = await mkdtemp(path.join(tmpdir(), "livenest-release-")); gh(["release", "download", tag, "--repo", repository, "--dir", downloaded]);
  for (const name of names) if (!(await readFile("release/" + name)).equals(await readFile(path.join(downloaded, name)))) throw new Error("Remote artifact differs: " + name);
  gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
}
