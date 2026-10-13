/** 更新展示的合成状态回归；不连接更新服务器或启动安装器。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import UpdateNotice from "../desktop/app/update-notice";
import UpdateAction from "../desktop/app/update-action";

it("shows reported progress and leaves unknown progress indeterminate", () => {
  const act = vi.fn();
  const known = renderToStaticMarkup(createElement(UpdateNotice, { version: "0.1.11", update: { status: "downloading", version: "0.1.13", percent: 42 }, busy: false, act }));
  expect(known).toContain('aria-valuenow="42"'); expect(known).toContain("正在下载 42%"); expect(known).toContain("disabled");
  const unknown = renderToStaticMarkup(createElement(UpdateNotice, { update: { status: "downloading" }, busy: false, act }));
  expect(unknown).not.toContain('aria-valuenow'); expect(unknown).not.toContain("下载 0%"); expect(act).not.toHaveBeenCalled();
});
it("keeps failure explanation visible and retries the correct phase with one action", () => {
  const act = vi.fn().mockResolvedValue(true);
  const html = renderToStaticMarkup(createElement(UpdateNotice, { update: { status: "error", stage: "download", message: "合成下载失败" }, busy: false, act }));
  expect(html).toContain('role="alert">合成下载失败');
  const button = UpdateAction({ update: { status: "error", stage: "download" }, busy: false, act }); button.props.onClick();
  expect(act).toHaveBeenCalledExactlyOnceWith("update-apply");
});
