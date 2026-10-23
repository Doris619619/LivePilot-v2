/** 管理员界面回归：预算边界、字段错误、分享查询与跨日显示使用合成数据。 */
import { describe, expect, it } from "vitest";
import { defaultYouTubePolicy, youtubePolicySchema } from "@/shared/youtube-usage";
import { policyFields, policyInputValues, validatePolicyInput } from "@/app/admin/youtube-policy-model";
import { parseUsageQuery, usageFilterTime, usageQuery } from "@/app/admin/youtube-usage-model";

describe("quota policy field feedback", () => {
  it("accepts a valid draft without changing its submitted policy", () => {
    expect(validatePolicyInput(policyInputValues(defaultYouTubePolicy))).toEqual({ policy: defaultYouTubePolicy, errors: {} });
  });
  it("rejects provider quotas previously accepted by the form and identifies the provider field", () => {
    const draft = { ...policyInputValues(defaultYouTubePolicy), providerDailyUnits: "999" };
    expect(validatePolicyInput(draft)).toEqual({ errors: { providerDailyUnits: expect.stringContaining("1,000") } });
  });
  it("keeps cleared zero-capable fields invalid instead of silently submitting zero", () => {
    expect(validatePolicyInput({ ...policyInputValues(defaultYouTubePolicy), sendUnits: "" })).toEqual({ errors: { sendUnits: expect.any(String) } });
  });
  it("attaches the two cross-field failures to their editable controls", () => {
    const draft = { ...policyInputValues(defaultYouTubePolicy), dailyUnits: "9500", controlReserve: "9600" };
    expect(validatePolicyInput(draft).errors).toEqual({ dailyUnits: expect.stringContaining("90%"), controlReserve: expect.stringContaining("小于") });
  });
  it.each(policyFields)("keeps the $key maximum aligned with the shared schema", field => {
    const value = field.max + 1;
    expect(youtubePolicySchema.safeParse({ ...defaultYouTubePolicy, [field.key]: value }).success).toBe(false);
    expect(validatePolicyInput({ ...policyInputValues(defaultYouTubePolicy), [field.key]: String(value) }).errors[field.key]).toBeTruthy();
  });
});

describe("admin investigation links", () => {
  it("round trips the selected day, device, method, minute window and pagination cursor", () => {
    const query = { day: "2026-10-23", agentId: "fixture_pc", instanceId: "main", method: "channels.list", purpose: "interactive", outcome: "succeeded", from: Date.parse("2026-10-23T12:00:00Z"), to: Date.parse("2026-10-23T12:00:59.999Z"), cursor: "1792756800000:00000000-0000-4000-8000-000000000001", limit: 100 };
    expect(parseUsageQuery(usageQuery(query))).toEqual(query);
  });
  it("drops unsafe or malformed shared parameters rather than breaking date rendering or API validation", () => {
    expect(parseUsageQuery("day=2026-02-30&agentId=../private&method=unknown&purpose=unknown&from=Infinity&to=-1&limit=999&cursor=wrong&token=secret")).toEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(parseUsageQuery("day=2026-10-23&from=100&to=99")).toEqual({ day: "2026-10-23" });
  });
  it("labels the selected timezone offset and changes calendar day across UTC midnight", () => {
    const at = Date.parse("2026-10-23T01:00:00Z");
    expect(usageFilterTime(at, "America/New_York")).toContain("10/22");
    expect(usageFilterTime(at, "America/New_York")).toContain("GMT-4");
    expect(usageFilterTime(at, "UTC")).toContain("10/23");
  });
});
