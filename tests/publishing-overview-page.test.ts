/** 总览分页回归：后台数据减少或频道移除后，保留的页码必须回到实际有内容的一页。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import MyPublishing from "@/app/publishing/my-publishing";
import type { VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";

const pagination = vi.hoisted(() => ({ page: 0 }));
vi.mock("@/app/use-url-state", async importOriginal => {
  const actual = await importOriginal<typeof import("@/app/use-url-state")>();
  return { ...actual, useUrlState: (...args: Parameters<typeof actual.useUrlState>) => args[0] === "publishing-page" ? [pagination.page, () => {}] : actual.useUrlState(...args) };
});

/** 以稳定的 URL 字段重建用户页码，渲染和数据减少后的钳制仍由真实组件计算。 */
async function overview(values: VideoJob[], page: number) {
  pagination.page = page;
  return renderToStaticMarkup(createElement(MyPublishing, { plans: [], jobs: values, busy: false, operate: async () => true, archive: async () => {} }));
}

/** 每个合成任务代表一个独立已配置批次，Cloud 删减只改变输入数据。 */
function jobs(count: number): VideoJob[] {
  return Array.from({ length: count }, (_, index) => { const spec = fixtureJob(); spec.profile.name = "Batch " + String(index + 1).padStart(2, "0"); return { spec, createdAt: 1 }; });
}

it("shows page two for 26 batches and returns to populated page one after the last batch disappears", async () => {
  const values = jobs(26); const before = await overview(values, 1);
  expect(before).toContain("Batch 26"); expect(before).not.toContain("Batch 25");
  expect(before).toContain("2 / 2 页 · 26 条");
  const after = await overview(values.slice(0, 25), 1);
  expect(after).toContain("Batch 01"); expect(after).toContain("Batch 25");
  expect(after.match(/aria-label="批次 /g)).toHaveLength(25);
  expect(after).not.toContain("还没有配置好的发布包"); expect(after).not.toContain("2 / 2 页");
});

it("clamps farther removed pages while keeping pagination and content on the same remaining page", async () => {
  const html = await overview(jobs(26), 3);
  expect(html).toContain("Batch 26"); expect(html).not.toContain("Batch 25");
  expect(html).toContain("2 / 2 页 · 26 条");
});

it("shows the real empty state when all configured batches disappear", async () => {
  const html = await overview([], 1);
  expect(html).toContain("还没有配置好的发布包"); expect(html).not.toContain("上一页");
});
