/** 文案字段优先级：人工和包内内容不会被未使用的模板或AI字段阻塞。 */
import { beforeEach, expect, it, vi } from "vitest";
import { publishingMetadata } from "@/core/publishing/metadata";
import type { Store } from "@/core/storage";
import { fixtureJob } from "./publishing-fixtures";
const ai = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/core/broadcast-ai", async importOriginal => ({ ...await importOriginal<typeof import("@/core/broadcast-ai")>(), requestAi: ai.request }));
beforeEach(() => ai.request.mockReset());
it("skips unused invalid templates when both fields were supplied", async () => {
  const job = fixtureJob(); job.profile.titleTemplate = "{{unsupported}}"; job.profile.descriptionTemplate = "{{unsupported}}";
  job.profile.ai.enabled = true; job.profile.ai.fallbackTitle = "{{unsupported}}"; job.profile.ai.fallbackDescription = "{{unsupported}}";
  job.overrides = { title: "Confirmed title", description: "" };
  expect(await publishingMetadata({} as Store, job)).toEqual({ copy: job.overrides, source: "override" }); expect(ai.request).not.toHaveBeenCalled();
});
it("generates only the missing field without rejecting an unused invalid AI title", async () => {
  const job = fixtureJob(); job.profile.ai.enabled = true; job.profile.titleTemplate = "{{unsupported}}"; job.profile.ai.fallbackTitle = "{{unsupported}}";
  job.overrides = { title: "Confirmed title" }; ai.request.mockResolvedValue({ title: "x".repeat(101), description: "Generated description" });
  expect(await publishingMetadata({} as Store, job)).toEqual({ copy: { title: "Confirmed title", description: "Generated description" }, source: "override" }); expect(ai.request).toHaveBeenCalledOnce();
});
