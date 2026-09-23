/** 管理员指标钻取与时区回归：包含没有 OBS 的电脑和未接入客户。 */
import { describe, expect, it } from "vitest";
import { groupOverview, updateTime, validTimeZone, type Overview } from "../src/app/admin/view-model";
/** 合成状态覆盖在线、离线、待分配及空设备；不读取运行数据。 */
function fixture(): Overview {
  const agents: Overview["agents"] = [
    { id: "a", name: "电脑 A", owner: "Liang", online: true, lastSeen: 1, revoked: false, instances: [] },
    { id: "b", name: "电脑 B", owner: "Demo", online: false, lastSeen: 1, revoked: false, instances: [] },
    { id: "c", name: "空电脑", online: true, lastSeen: 1, revoked: false, instances: [] },
  ];
  const rows: Overview["rows"] = [
    { agentId: "a", instanceId: "1", customer: "Liang", device: "电脑 A", name: "视频", online: true, streaming: true, durationMs: 60000, channel: undefined, lifecycle: undefined, lastSeen: 1, error: undefined, actor: undefined },
    { agentId: "a", instanceId: "2", customer: "Liang", device: "电脑 A", name: "音乐", online: true, streaming: false, durationMs: 0, channel: undefined, lifecycle: undefined, lastSeen: 1, error: "密码错误", actor: undefined },
    { agentId: "b", instanceId: "3", customer: "Demo", device: "电脑 B", name: "旧状态", online: false, streaming: null, durationMs: undefined, channel: undefined, lifecycle: undefined, lastSeen: 1, error: "已离线", actor: undefined },
  ];
  return { at: 1, agents, rows, customers: ["Liang", "Demo", "New"].map(username => ({ username, role: "customer" })), totals: { live: 1, online: 2, offline: 1, customers: 3, errors: 1, unknown: 1 } };
}
describe("admin drilldowns", () => {
  it("groups two OBS under one customer and one computer", () => {
    const groups = groupOverview(fixture(), "all", "Liang");
    expect(groups).toHaveLength(1); expect(groups[0].devices).toHaveLength(1); expect(groups[0].devices[0].rows).toHaveLength(2);
  });
  it("matches each instance metric and excludes offline errors", () => {
    const data = fixture();
    for (const [scope, count] of [["live", data.totals.live], ["error", data.totals.errors], ["unknown", data.totals.unknown]] as const) {
      expect(groupOverview(data, scope).flatMap(g => g.devices.flatMap(d => d.rows))).toHaveLength(count);
    }
    expect(groupOverview(data, "error")[0].customer).toBe("Liang");
  });
  it("includes zero-OBS computers and zero-device customers in their metric", () => {
    const data = fixture();
    expect(groupOverview(data, "online").flatMap(g => g.devices)).toHaveLength(data.totals.online);
    expect(groupOverview(data, "offline").flatMap(g => g.devices)).toHaveLength(data.totals.offline);
    expect(groupOverview(data, "customers").map(g => g.customer)).toEqual(["Liang", "Demo", "New"]);
    expect(groupOverview(data, "all", "unassigned")[0].devices[0].agent.id).toBe("c");
    expect(groupOverview(data, "live", "Demo")).toEqual([]);
  });
  it("converts the same instant across dates and rejects damaged timezone preferences", () => {
    const at = Date.parse("2026-09-23T20:30:00Z");
    expect(updateTime(at, "UTC")).toBe("2026/09/23 20:30:00");
    expect(updateTime(at, "Asia/Shanghai")).toBe("2026/09/24 04:30:00");
    expect(validTimeZone("broken/value")).toBe(false);
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(updateTime(0, "UTC")).toBe("未上线");
  });
});
