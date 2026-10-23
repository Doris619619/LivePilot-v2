/** URL 状态回归：筛选往返、无效输入和连续查询更新不覆盖其他模块的条件。 */
import { describe, expect, it } from "vitest";
import { mergeUrlValues, readUrlValue } from "../src/app/use-url-state";

describe("shareable interface state", () => {
  it("retains other filters and anchors when updating independent fields", () => {
    const first = mergeUrlValues("/publishing?customer=demo&history-page=2#plan", { "publishing-view": "history" });
    const second = mergeUrlValues(first, { "history-page": 3 });
    const url = new URL(second, "http://localhost");
    expect(url.searchParams.get("customer")).toBe("demo");
    expect(url.searchParams.get("publishing-view")).toBe("history");
    expect(url.searchParams.get("history-page")).toBe("3");
    expect(url.hash).toBe("#plan");
  });
  it("removes cleared filters without losing the selected route", () => {
    expect(mergeUrlValues("/admin?tab=youtube&search=abc", { search: undefined })).toBe("/admin?tab=youtube");
  });
  it("restores typed values and rejects malformed serialized state", () => {
    expect(readUrlValue("/admin?page=4", "page", 0)).toBe(4);
    expect(readUrlValue("/admin?page=invalid", "page", 0)).toBe(0);
    expect(readUrlValue("/admin?query=bad", "query", {}, JSON.parse)).toEqual({});
    expect(readUrlValue("", "tab", "devices")).toBe("devices");
  });
});
