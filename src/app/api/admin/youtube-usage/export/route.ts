/** 管理员安全调用导出：与明细共用筛选，明确注明名义成本及缺失。 */
import { failed } from "@/server/http";
import { streamYouTubeEvents } from "@/cloud/youtube-usage-events";
import { YOUTUBE_COST_VERSION } from "@/shared/youtube-usage";
import { youtubeAdmin, youtubeQuery } from "../http";
export const runtime = "nodejs";
/** 只导出白名单事件；逐段流式读取所有匹配记录，末尾明确记录轮转竞争缺口。 */
export async function GET(request: Request) { try {
  await youtubeAdmin(request); const query = youtubeQuery(request); const csv = query.format === "csv";
  const meta = { schema: 1, costVersion: YOUTUBE_COST_VERSION, estimated: true, filters: { day: query.day, from: query.from, to: query.to } };
  const columns = ["at", "agentId", "instanceId", "accountId", "attemptId", "operationId", "jobId", "method", "purpose", "trigger", "kind", "decision", "blockReason", "outcome", "httpStatus", "grpcStatus", "estimatedUnits", "durationMs", "retryCount", "retryDelayMs", "streamBatches", "streamMessages"] as const;
  /** 元数据值只来自固定字段；CSV仍逐值引号包裹避免分隔符混淆。 */
  const quote = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const encoder = new TextEncoder(); const iterator = streamYouTubeEvents({ ...query, cursor: undefined }); let started = false;
  const body = new ReadableStream<Uint8Array>({
    /** 下游按需拉取一段；取消下载会关闭迭代器，不继续扫描磁盘。 */
    async pull(controller) {
      try {
        if (!started) { started = true; controller.enqueue(encoder.encode(csv ? "# " + JSON.stringify(meta) + "\r\n" + columns.join(",") + "\r\n" : JSON.stringify(meta) + "\n")); return; }
        const next = await iterator.next(); if (next.done) { controller.close(); return; }
        const value = next.value; const text = value.event ? csv ? columns.map(key => quote(value.event![key])).join(",") + "\r\n" : JSON.stringify(value.event) + "\n" : csv ? "# " + JSON.stringify(value.metadata) + "\r\n" : JSON.stringify({ ...value.metadata, type: "completeness" }) + "\n";
        controller.enqueue(encoder.encode(text));
      } catch (error) { controller.error(error); }
    },
    /** 客户端取消不触发新的网络请求或任何YouTube重试。 */
    async cancel() { await iterator.return(undefined); },
  });
  return new Response(body, { headers: { "Cache-Control": "no-store", "Content-Type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="youtube-usage.' + (csv ? "csv" : "ndjson") + '"' } });
} catch (error) { return failed(error); } }
