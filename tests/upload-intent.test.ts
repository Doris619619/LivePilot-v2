/** 上传失回执句柄的严格恢复与归属回归；不连接任何设备或外部平台。 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { readUploadIntent, uploadIntentHandle, assertUploadIntent } from "@/app/upload-intent";
import type { UploadStatus } from "@/shared/uploads";
/** 兼容旧本机缓存与多设备缓存，两者均必须固定原幂等ID。 */
it.each(["main", "pc_b:main"])("restores the complete original target, music kind and request ID from %s", target => {
  const source = { target, kind: "music", requestId: randomUUID(), fingerprint: "a".repeat(64) }; const intent = readUploadIntent(JSON.parse(JSON.stringify(source)));
  expect(intent).toEqual(source); const handle = uploadIntentHandle(intent);
  expect(handle).toEqual({ id: source.requestId, instanceId: "main", ...(target.includes(":") ? { agentId: "pc_b" } : {}) });
  const status = { ...handle, kind: "music", fingerprint: source.fingerprint } as UploadStatus;
  expect(() => assertUploadIntent(intent, status)).not.toThrow();
  for (const change of [{ id: randomUUID() }, { agentId: "pc_a" }, { instanceId: "other" }, { kind: "videos" }, { fingerprint: "b".repeat(64) }]) expect(() => assertUploadIntent(intent, { ...status, ...change } as UploadStatus)).toThrow("原创建意图");
});
/** 错误数据不能产生跨目标或不完整的“已恢复”句柄，更不能接受任意路径。 */
it.each(["pc_b:main:other", "../main", ":main", "pc_b:"])("rejects malformed target %s without inventing a first-device fallback", target => {
  expect(() => readUploadIntent({ target, kind: "videos", requestId: randomUUID(), fingerprint: "a".repeat(64) })).toThrow();
});
it("rejects missing request identity and unknown metadata instead of silently overwriting an old intent", () => {
  const input = { target: "pc_b:main", kind: "videos", requestId: randomUUID(), fingerprint: "a".repeat(64) };
  expect(() => readUploadIntent({ ...input, requestId: undefined })).toThrow(); expect(() => readUploadIntent({ ...input, rawToken: "synthetic-secret" })).toThrow();
});
