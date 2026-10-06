/** 发布时区目录：常用城市中文名、指定日期的 UTC 偏移及所有运行时支持的 IANA 时区。 */
export type TimezoneOption = { value: string; city: string; offset: string; label: string };
const cities: Record<string, string> = {
  UTC: "世界协调时", "Asia/Shanghai": "北京 / 上海", "Asia/Hong_Kong": "香港", "Asia/Taipei": "台北", "Asia/Singapore": "新加坡", "Asia/Tokyo": "东京", "Asia/Seoul": "首尔", "Asia/Bangkok": "曼谷", "Asia/Kolkata": "新德里", "Asia/Dubai": "迪拜",
  "America/New_York": "纽约", "America/Los_Angeles": "洛杉矶", "America/Chicago": "芝加哥", "America/Denver": "丹佛", "America/Toronto": "多伦多", "America/Vancouver": "温哥华", "America/Sao_Paulo": "圣保罗",
  "Europe/London": "伦敦", "Europe/Paris": "巴黎", "Europe/Berlin": "柏林", "Europe/Moscow": "莫斯科", "Australia/Sydney": "悉尼", "Australia/Perth": "珀斯", "Pacific/Auckland": "奥克兰",
};
/** 接受 Intl 支持的合法名称，包括未列在 canonical 清单中的旧别名；非法输入不能成为选项。 */
export function validTimezone(value: string) { try { new Intl.DateTimeFormat("en", { timeZone: value }); return !!value; } catch { return false; } }
/** 偏移随开始日期及夏令时变化；日期暂为空时不显示容易误导的固定偏移。 */
export function timezoneOption(value: string, date: string): TimezoneOption {
  const at = new Date(date + "T12:00:00Z"); let offset = "";
  if (Number.isFinite(at.getTime())) {
    const name = new Intl.DateTimeFormat("en", { timeZone: value, timeZoneName: "longOffset" }).formatToParts(at).find(part => part.type === "timeZoneName")?.value || "GMT";
    offset = name === "GMT" ? "UTC+00:00" : name.replace("GMT", "UTC");
  }
  const city = cities[value] || value.split("/").at(-1)!.replaceAll("_", " ");
  return { value, city, offset, label: [city, offset, value].filter(Boolean).join(" · ") };
}
/** 当前值和常用城市排前；完整支持列表仍参与搜索，不依赖硬编码的少量时区。 */
export function timezoneOptions(current: string, date: string): TimezoneOption[] {
  const supported = Intl.supportedValuesOf("timeZone");
  return [...new Set([current, ...Object.keys(cities), ...supported])].filter(validTimezone).map(value => timezoneOption(value, date));
}
/** 可按中文城市、IANA 或 UTC 偏移搜索；合法别名也能直接搜索并明确选择。 */
export function filterTimezones(options: TimezoneOption[], query: string, date: string): TimezoneOption[] {
  const trimmed = query.trim(); const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = options.filter(option => tokens.every(token => option.label.toLowerCase().includes(token)));
  if (trimmed && !options.some(option => option.value.toLowerCase() === trimmed.toLowerCase()) && validTimezone(trimmed)) filtered.unshift(timezoneOption(trimmed, date));
  return filtered;
}
