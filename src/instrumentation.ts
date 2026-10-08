/** 运行时启动云端发布 Scheduler 或单机聊天；构建和 Edge 不执行后台业务。 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.LIVEPILOT_MODE === "cloud") {
    const { startPublishingScheduler } = await import("./cloud/publishing"); await startPublishingScheduler();
  } else {
    const { startLocalChat } = await import("./server/local-chat"); startLocalChat();
  }
}
