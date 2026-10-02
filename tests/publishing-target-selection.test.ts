/** 发布目标恢复覆盖多账号、OAuth 优先、权限变化和损坏缓存，不能复活清理中的授权。 */
import { expect, it } from "vitest";
import type { PublishingAccount, PublishingPlan } from "@/shared/publishing";
import { publishingTargetStorageKey, restorePublishingTarget } from "@/app/publishing/publishing-target-selection";
const targets = [{ agentId: "pc", instanceId: "main" }, { agentId: "pc_two", instanceId: "main" }];
const accounts: PublishingAccount[] = [
  { id: "first", agentId: "pc", instanceId: "main", owner: "alice", name: "First", status: "connected", channelId: "first_channel", createdAt: 1, updatedAt: 1 },
  { id: "second", agentId: "pc_two", instanceId: "main", owner: "alice", name: "Second", status: "connected", channelId: "second_channel", createdAt: 1, updatedAt: 1 },
  { id: "third", agentId: "pc", instanceId: "main", owner: "alice", name: "Third", status: "connected", channelId: "third_channel", createdAt: 1, updatedAt: 1 },
];

it("restores the second device and same-device third account ahead of any newer unfinished draft", () => {
  const plans = [{ profile: { agentId: "pc", instanceId: "main", accountId: "first" }, createdAt: 200 }] as PublishingPlan[];
  expect(restorePublishingTarget(targets, accounts, plans, { agentId: "pc_two", instanceId: "main", accountId: "second" })).toEqual({ agentId: "pc_two", instanceId: "main", accountId: "second" });
  expect(restorePublishingTarget(targets, accounts, plans, { agentId: "pc", instanceId: "main", accountId: "third" })).toEqual({ agentId: "pc", instanceId: "main", accountId: "third" });
});

it("prioritizes the OAuth returned account over the persisted selection", () => {
  expect(restorePublishingTarget(targets, accounts, [], { agentId: "pc", instanceId: "main", accountId: "third" }, "second")).toEqual({ agentId: "pc_two", instanceId: "main", accountId: "second" });
});

it("preserves an unbound account for retry while refusing cleaned, deleted and foreign target identities", () => {
  const unbound = accounts.map(account => ({ ...account, status: account.id === "third" ? "unbound" as const : account.status }));
  const saved = { agentId: "pc", instanceId: "main", accountId: "third" };
  expect(restorePublishingTarget(targets, unbound, [], saved)?.accountId).toBe("third");
  for (const status of ["cleanup_pending", "deleted"] as const) {
    const removed = accounts.map(account => ({ ...account, status: account.id === "third" ? status : account.status }));
    expect(restorePublishingTarget(targets, removed, [], saved)?.accountId).toBe("first");
    expect(restorePublishingTarget(targets, removed, [], saved, "third")?.accountId).toBe("first");
  }
  expect(restorePublishingTarget(targets, accounts, [], { ...saved, accountId: "second" })).toEqual({ agentId: "pc", instanceId: "main", accountId: "first" });
  expect(restorePublishingTarget([targets[0]], accounts, [], { agentId: "pc_two", instanceId: "main", accountId: "second" }, "second")?.accountId).toBe("first");
});

it("keeps an explicitly selected device without an account and safely falls back for unusable cached data", () => {
  expect(restorePublishingTarget(targets, accounts, [], { agentId: "pc_two", instanceId: "main", accountId: "" })).toEqual({ agentId: "pc_two", instanceId: "main", accountId: "" });
  for (const saved of [null, "not an object", [], { agentId: "outside", instanceId: "main", accountId: "third" }]) expect(restorePublishingTarget(targets, accounts, [], saved)?.accountId).toBe("first");
  expect(restorePublishingTarget(targets, [], [], null)).toEqual({ agentId: "pc", instanceId: "main", accountId: "" });
  expect(restorePublishingTarget([], accounts, [], null)).toBeUndefined();
  expect(publishingTargetStorageKey("alice")).not.toBe(publishingTargetStorageKey("bob"));
});
