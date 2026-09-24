/** 只读取固定公开发行仓库的稳定 Windows 安装包，不接收任意上游地址。 */
import "server-only";
import { z } from "zod";
const repository = "https://github.com/Doris619619/LiveNest-Releases";
const releaseSchema = z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), published_at: z.string().nullable(), assets: z.array(z.object({ name: z.string(), size: z.number().nonnegative(), browser_download_url: z.string() })) });
export type PublicRelease = { version: string; publishedAt: string; size: number; download: string; notes: string };
/** 校验安装包名称和来源，草稿、预发布、缺失安装包及异常链接均不公开。 */
export function publicReleases(value: unknown): PublicRelease[] {
  const parsed = z.array(releaseSchema).max(100).parse(value);
  return parsed.flatMap(release => {
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !release.published_at || !Number.isFinite(Date.parse(release.published_at))) return [];
    const version = release.tag_name.slice(1); const name = `LiveNest_${version}_x64-setup.exe`;
    const download = `${repository}/releases/download/${release.tag_name}/${name}`;
    const asset = release.assets.find(a => a.name === name && a.browser_download_url === download && a.size > 0);
    return asset ? [{ version, publishedAt: release.published_at, size: asset.size, download, notes: `${repository}/releases/tag/${release.tag_name}` }] : [];
  });
}
/** 分页读取并缓存五分钟，上游故障不返回内部错误或伪造下载地址。 */
export async function releaseHistory(page: number) {
  const response = await fetch(`https://api.github.com/repos/Doris619619/LiveNest-Releases/releases?per_page=20&page=${page}`, { headers: { Accept: "application/vnd.github+json" }, next: { revalidate: 300 }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Release list unavailable");
  const raw: unknown = await response.json();
  return { releases: publicReleases(raw), hasMore: Array.isArray(raw) && raw.length === 20 };
}
