/** 客户故障卡必须显示预算恢复时间，非法日期不能阻断整个设备页面。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import ProblemCard from "../src/app/components/problem-card";
import type { Problem } from "../src/shared/problems";
/** 合成预算问题不带设备凭据或任何上游请求。 */
function problem(retryAt?: number): Problem { return { version: 1, source: "agent", code: "YOUTUBE_PROTECTION_WAIT", domain: "youtube", target: { instanceId: "main" }, severity: "error", stage: "配额准入", outcome: "not-sent", observedAt: 1, message: "等待预算恢复", actions: ["refresh"], context: { retryAt } }; }
it("shows a machine-readable recovery time to the device owner", () => {
  const retryAt = Date.parse("2026-10-21T07:00:00Z");
  const html = renderToStaticMarkup(createElement(ProblemCard, { problem: problem(retryAt) }));
  expect(html).toContain("下次检查时间"); expect(html).toContain('dateTime="2026-10-21T07:00:00.000Z"');
});
it("does not show a misleading recovery date for absent or invalid timestamps", () => {
  for (const retryAt of [undefined, Number.NaN, 1e20]) expect(renderToStaticMarkup(createElement(ProblemCard, { problem: problem(retryAt) }))).not.toContain("下次检查时间");
});
