/** 云端进程启动发布 Scheduler；构建/Edge/local 模式不会执行后台发布。 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build" || process.env.LIVEPILOT_MODE !== "cloud") return;
  const { startPublishingScheduler } = await import("./cloud/publishing"); await startPublishingScheduler();
}
