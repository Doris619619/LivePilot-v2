/** 目录与时区选择回归：不猜远程路径，搜索常用城市和完整时区，并显示日期对应偏移。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { publishingInboxPath } from "@/app/publishing/publishing-directory";
import { filterTimezones, timezoneOption, timezoneOptions } from "@/app/publishing/timezone-options";
import TimezoneSelect from "@/app/publishing/timezone-select";

it("keeps the selected Agent absolute path and never duplicates Inbox", () => {
  expect(publishingInboxPath("D:\\客户直播\\LiveNest\\Publishing\\")).toBe("D:\\客户直播\\LiveNest\\Publishing\\Inbox");
  expect(publishingInboxPath("E:/LiveNest/Publishing/Inbox/")).toBe("E:/LiveNest/Publishing/Inbox");
  expect(publishingInboxPath("/local/Publishing")).toBe("/local/Publishing/Inbox");
  expect(publishingInboxPath("")).toBe("");
  expect(publishingInboxPath("Publishing")).toBe("");
});

it("shows Chinese common cities with date-aware daylight-saving offsets and IANA identities", () => {
  expect(timezoneOption("America/New_York", "2030-07-01").label).toBe("纽约 · UTC-04:00 · America/New_York");
  expect(timezoneOption("America/New_York", "2030-01-01").offset).toBe("UTC-05:00");
  expect(timezoneOption("Asia/Shanghai", "2030-01-01").label).toBe("北京 / 上海 · UTC+08:00 · Asia/Shanghai");
  expect(timezoneOption("UTC", "2030-01-01").offset).toBe("UTC+00:00");
});

it("searches common Chinese cities and every canonical timezone supported by the browser runtime", () => {
  const options = timezoneOptions("UTC", "2030-07-01");
  expect(filterTimezones(options, "纽约", "2030-07-01").map(option => option.value)).toEqual(["America/New_York"]);
  expect(filterTimezones(options, "Pacific/Chatham", "2030-07-01").map(option => option.value)).toContain("Pacific/Chatham");
  expect(filterTimezones(options, "UTC+08:00", "2030-07-01").map(option => option.value)).toContain("Asia/Shanghai");
  for (const zone of Intl.supportedValuesOf("timeZone")) expect(options.some(option => option.value === zone)).toBe(true);
});

it("allows valid aliases and fixed-offset timezone names without accepting incomplete or invalid input", () => {
  const options = timezoneOptions("UTC", "2030-07-01");
  expect(filterTimezones(options, "Etc/GMT+5", "2030-07-01")[0]).toMatchObject({ value: "Etc/GMT+5", offset: "UTC-05:00" });
  expect(filterTimezones(options, "US/Eastern", "2030-07-01")[0]).toMatchObject({ value: "US/Eastern", offset: "UTC-04:00" });
  expect(filterTimezones(options, "invalid/timezone", "2030-07-01")).toEqual([]);
});

it("offers an explicit dropdown and lets damaged old draft timezone values be repaired", () => {
  const selected = renderToStaticMarkup(createElement(TimezoneSelect, { value: "America/New_York", date: "2030-07-01", change: () => {} }));
  expect(selected).toContain('aria-haspopup="listbox"'); expect(selected).toContain('aria-expanded="false"');
  expect(selected).toContain("纽约 · UTC-04:00"); expect(selected).toContain("America/New_York");
  const invalid = renderToStaticMarkup(createElement(TimezoneSelect, { value: "", date: "", change: () => {} }));
  expect(invalid).toContain("请选择时区");
});
