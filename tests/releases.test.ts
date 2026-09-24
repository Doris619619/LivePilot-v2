/** 公开发行列表只接受真实稳定安装资产，拒绝外部链接、草稿和伪造版本。 */
import { afterEach, expect, it, vi } from "vitest";
import { publicReleases } from "@/server/releases";
import { GET } from "@/app/api/releases/route";
const release = { tag_name: "v0.1.7", draft: false, prerelease: false, published_at: "2026-09-24T00:00:00Z", assets: [{ name: "LiveNest_0.1.7_x64-setup.exe", size: 100, browser_download_url: "https://github.com/Doris619619/LiveNest-Releases/releases/download/v0.1.7/LiveNest_0.1.7_x64-setup.exe" }] };
afterEach(() => vi.unstubAllGlobals());
it("lists exact official assets and excludes unstable or missing installers", () => {
  expect(publicReleases([release])[0]).toMatchObject({ version: "0.1.7", size: 100 });
  for (const value of [{ ...release, draft: true }, { ...release, prerelease: true }, { ...release, assets: [] }, { ...release, tag_name: "../../test" }, { ...release, assets: [{ ...release.assets[0], browser_download_url: "https://evil.example/file.exe" }] }]) expect(publicReleases([value])).toEqual([]);
});
it("rejects arbitrary page input and returns safe upstream failure", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("SECRET")); vi.stubGlobal("fetch", fetcher);
  expect((await GET(new Request("https://example/api/releases?page=https://evil"))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  const response = await GET(new Request("https://example/api/releases")); expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
});
