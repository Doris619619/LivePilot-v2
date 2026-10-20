/** 本地运行核心：供 Windows Agent 和本地控制台共同使用。 */
import { randomBytes } from "node:crypto";
import type { ControlState, Selection } from "@/shared/types";
import type { ObsRuntime } from "./obs/runtime";
import type { YouTubePort } from "./youtube/api";
import { Store } from "./storage";
import { AppError, isAppError, safeError, waitFor } from "./errors";
import { makeProblem } from "@/shared/problems";
export const initialState = (): ControlState => ({ phase: "idle", stage: "等待开始", updatedAt: new Date().toISOString() });
export class Control {
  busy = false;
  /** 实例级互斥控制依赖；停止意图通过独立回调立即取消聊天，避免平台收尾失败后仍发送。 */
  constructor(readonly obs: ObsRuntime, readonly youtube: YouTubePort, readonly storage: Store,
    private media: (selection: Selection) => Promise<{ video: string; music: string }>,
    private wait: typeof waitFor = waitFor,
    private applyChat?: (selection: Selection) => Promise<void>,
    private stopChat?: () => Promise<void>) {}
  async state() { return await this.storage.read<ControlState>("control.json") || initialState(); }
  private async save(state: ControlState, patch: Partial<ControlState>) {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    await this.storage.write("control.json", state);
  }
  async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new AppError("BUSY", "正在执行控制操作，请等待当前步骤完成。", 409);
    this.busy = true;
    try { return await this.storage.exclusive(fn); }
    finally { this.busy = false; }
  }
  private async operation(fn: (state: ControlState) => Promise<void>) {
    return this.exclusive(async () => {
      const state = await this.state();
      try { await fn(state); }
      catch (error) {
        await this.save(state, { phase: "error", error: safeError(error) });
        throw error;
      }
      return state;
    });
  }
  async launch() {
    return this.exclusive(async () => { await this.obs.ensureReady(); });
  }
  /** 固化本次媒体与直播详情；详情准备失败时不启动推流，重试复用相同场次。 */
  async start(selection: Selection) {
    return this.operation(async state => {
      if (state.platformClosePending || state.stopRequested && state.phase !== "stopped") throw new AppError("RECOVER", "上一场仍待结束，请先完成 YouTube 场次收尾后再开播。");
      const channel = await this.youtube.channel();
      if (state.channelId && state.channelId !== channel.id && state.phase !== "stopped") throw new AppError("CHANNEL", "请连接原直播使用的 Channel 后先结束该场次。");
      let current = state.broadcastId ? await this.youtube.broadcast(state.broadcastId) : null;
      if (state.broadcastId && (!current || current.status.lifeCycleStatus === "complete") && state.phase !== "stopped") {
        throw new AppError("RECOVER", "该场次已结束或被删除。请先点击结束直播，确认 OBS 已停止后再创建下一场。");
      }
      if (state.phase === "stopped" || state.phase === "idle") {
        const oldStream = state.channelId === channel.id ? state.streamId : undefined;
        Object.keys(state).forEach(key => { delete (state as unknown as Record<string, unknown>)[key]; });
        Object.assign(state, initialState(), { channelId: channel.id, streamId: oldStream });
        current = null;
      }
      if (state.selection && state.broadcastTitle && JSON.stringify(state.selection) !== JSON.stringify(selection)) throw new AppError("RECOVER", "恢复当前场次时请保留原媒体与直播详情，或先结束当前场次再更换。");
      const files = await this.media(selection);
      await this.applyChat?.(selection);
      await this.save(state, { phase: "starting", stage: "准备 OBS", error: undefined, channelId: channel.id, selection });
      await this.obs.ensureReady();
      const obs = await this.obs.status();
      if (!obs.ready) throw new AppError("OBS_OFFLINE", "OBS 未就绪，不能继续开播。");
      if (obs.streaming && !state.obsStartRequested) throw new AppError("OBS_BUSY", "OBS 正在推流，且不是本应用启动的场次。请先在 OBS / YouTube Studio 核对并结束它。");
      if (current?.status.lifeCycleStatus === "live") {
        if (current.contentDetails?.boundStreamId !== state.streamId) throw new AppError("RECOVER", "直播绑定与本机记录不一致，请先在 YouTube Studio 核对。");
        if (!obs.streaming) throw new AppError("RECOVER", "YouTube 仍在直播但 OBS 已停止，请先结束该场次再重开。");
        const stream = state.streamId ? await this.youtube.stream(state.streamId) : null;
        if (stream?.status.streamStatus !== "active") throw new AppError("INGEST", "YouTube 仍在直播，但未确认收到推流。请检查网络或结束该场次。");
        await this.save(state, { phase: "live", stage: "直播中", startedAt: current.snippet.actualStartTime || state.startedAt });
        return;
      }
      if (!obs.streaming) {
        await this.save(state, { stage: "校验 LIVE / VIDEO / MUSIC" });
        await this.obs.validate();
        await this.save(state, { stage: "设置视频、音乐和视频原声" });
        await this.obs.setMedia(files.video, files.music, selection.videoAudio);
      }
      await this.save(state, { stage: "准备 YouTube 场次" });
      if (!state.broadcastId) {
        if (state.broadcastIntent) {
          const found = await this.youtube.findBroadcast(state.broadcastTitle!);
          if (!found) throw new AppError("UNCERTAIN", "上次创建场次的结果不确定，当前尚未查到。请稍后重试；若持续未找到，请在 YouTube Studio 核实后使用“连接与诊断”中的“清理未确认状态”。");
          await this.save(state, { broadcastId: found.id, broadcastIntent: false });
        } else {
          const title = "LivePilot " + new Date().toISOString().replace(/[:.]/g, "-") + " " + randomBytes(4).toString("hex");
          await this.save(state, { broadcastTitle: title, broadcastIntent: true });
          const created = await this.youtube.createBroadcast(title, selection.broadcast);
          if (!created.id) throw new AppError("YOUTUBE_API", "YouTube 未返回场次标识，请重试以核对创建结果。");
          await this.save(state, { broadcastId: created.id, broadcastIntent: false });
        }
      }
      // Never continue preparing a recovered object without reading its lifecycle.
      current = await this.youtube.broadcast(state.broadcastId!);
      if (!current || !["created", "ready", "liveStarting", "live"].includes(current.status.lifeCycleStatus)) throw new AppError("RECOVER", "YouTube 场次不在可开播状态，请结束或在 YouTube Studio 核对。");
      if (selection.broadcast && !state.detailsApplied) {
        if (!this.youtube.prepareBroadcast) throw new AppError("CONFIG", "当前 Agent 不支持直播详情，请升级后重试。");
        await this.save(state, { stage: "设置直播详情、封面与播放列表" });
        await this.youtube.prepareBroadcast(state.broadcastId!, selection.broadcast);
        await this.save(state, { detailsApplied: true });
      }
      if (!state.streamId) {
        if (state.streamIntent) {
          const found = await this.youtube.findStream(state.streamTitle!);
          if (!found) throw new AppError("UNCERTAIN", "上次创建推流对象结果不确定，请稍后重试或在 YouTube Studio 核对。");
          await this.save(state, { streamId: found.id, streamIntent: false });
        } else {
          await this.save(state, { streamTitle: "LivePilot-v2 " + randomBytes(12).toString("hex"), streamIntent: true });
          const created = await this.youtube.createStream(state.streamTitle!);
          if (!created.id) throw new AppError("YOUTUBE_API", "YouTube 未返回推流标识，请重试以核对结果。");
          await this.save(state, { streamId: created.id, streamIntent: false });
        }
      }
      const stream = await this.youtube.stream(state.streamId!);
      if (!stream) throw new AppError("RECOVER", "当前推流对象已不存在，请先结束当前场次。");
      if (stream.status.streamStatus === "active" && !state.obsStartRequested) throw new AppError("INGEST_BUSY", "此推流对象已被其他推流占用，请先在 YouTube Studio 核对。");
      if (current.contentDetails?.boundStreamId !== state.streamId) {
        if (obs.streaming || ["live", "liveStarting"].includes(current.status.lifeCycleStatus)) throw new AppError("RECOVER", "直播绑定与本机状态不一致，请先结束或在 YouTube Studio 核对。");
        await this.youtube.bind(state.broadcastId!, state.streamId!);
        current = await this.youtube.broadcast(state.broadcastId!);
        if (current?.contentDetails?.boundStreamId !== state.streamId) throw new AppError("BIND", "YouTube 未确认绑定，已停止后续开播步骤。");
      }
      if (!obs.streaming) {
        const ingest = stream.cdn?.ingestionInfo;
        if (!ingest?.rtmpsIngestionAddress || !ingest.streamName) throw new AppError("INGEST", "YouTube 未返回安全推流地址与 Stream Key。");
        await this.save(state, { stage: "配置 OBS 推流" });
        await this.obs.setStream(ingest.rtmpsIngestionAddress, ingest.streamName);
        await this.save(state, { stage: "启动 OBS 推流", obsStartRequested: true });
        await this.obs.startStream();
      }
      await this.save(state, { stage: "等待 YouTube 收到推流" });
      await this.wait(() => this.youtube.stream(state.streamId!), value => value?.status.streamStatus === "active", "YouTube 未在时限内收到推流。OBS 可能仍在推流，请检查 OBS 网络后重试或点击结束直播。");
      await this.save(state, { stage: "请求 YouTube 开播" });
      current = await this.youtube.broadcast(state.broadcastId!);
      if (!["live", "liveStarting"].includes(current?.status.lifeCycleStatus || "")) await this.youtube.transition(state.broadcastId!, "live");
      const live = await this.wait(() => this.youtube.broadcast(state.broadcastId!), value => value?.status.lifeCycleStatus === "live", "YouTube 开播结果未确认。请刷新状态后重试或结束直播。");
      const confirmedObs = await this.obs.status();
      if (!confirmedObs.ready || !confirmedObs.streaming) throw new AppError("OBS_LOST", "YouTube 已开播，但 OBS 推流状态异常。请立即检查或结束该场次。");
      await this.save(state, { phase: "live", stage: "直播中", startedAt: live!.snippet.actualStartTime || new Date().toISOString(), error: undefined });
    });
  }
  /** 先取消聊天并停止属于本场的 OBS；平台失败保留收尾意图，本机应急停止不访问 YouTube。 */
  async stop(options: { localOnly?: boolean } = {}) {
    return this.operation(async state => {
      await this.save(state, { phase: "stopping", stage: "停止 OBS 推流", stopRequested: true, platformClosePending: !!(state.broadcastId || state.broadcastIntent), error: undefined });
      // 聊天先取消 socket 与发送；检查点保存失败不能阻止本机停止推流。
      try { await this.stopChat?.(); } catch { /* 状态和检查点问题由聊天状态回报。 */ }
      let obs = await this.obs.status();
      if (obs.streaming && !state.obsStartRequested) throw new AppError("OBS_FOREIGN", "OBS 存在不属于此场次的推流，请到 OBS 核对；本应用没有停止它。");
      if (obs.streaming === null || (obs.running && !obs.ready)) throw new AppError("OBS_OFFLINE", "无法确认 OBS 状态。请恢复 WebSocket 后再次结束直播；必要时在 OBS 手动停止推流。");
      if (obs.streaming) await this.obs.stopStream();
      obs = await this.wait(() => this.obs.status(), value => value.streaming === false, "OBS 尚未确认停止推流。请恢复连接后重试，必要时在 OBS 手动停止。", 30_000, 1500);
      if (obs.streaming !== false) throw new AppError("OBS_STOP", "OBS 未确认停止。");
      await this.save(state, { obsStartRequested: false, obsStoppedAt: new Date().toISOString(), stage: state.platformClosePending ? "OBS 已停止；YouTube 场次待结束" : "已结束" });
      if (options.localOnly && state.platformClosePending) return;
      try { if (state.broadcastId || state.broadcastIntent) {
        const channel = await this.youtube.channel();
        if (channel.id !== state.channelId) throw new AppError("CHANNEL", "请连接创建此场次的原 YouTube Channel。");
        if (!state.broadcastId) {
          const recovered = await this.youtube.findBroadcast(state.broadcastTitle!);
          if (!recovered) throw new AppError("UNCERTAIN", "无法确定之前是否创建成功，请在 YouTube Studio 核对后使用高级恢复清理。");
          await this.save(state, { broadcastId: recovered.id, broadcastIntent: false });
        }
        const current = await this.youtube.broadcast(state.broadcastId!);
        // Missing means the user has deleted the pending broadcast in Studio.
        if (current && current.status.lifeCycleStatus !== "complete") {
          await this.save(state, { stage: "结束 YouTube 直播" });
          await this.youtube.transition(state.broadcastId!, "complete");
          await this.wait(() => this.youtube.broadcast(state.broadcastId!), value => value?.status.lifeCycleStatus === "complete", "YouTube 未确认结束。");
        }
      } } catch (error) {
        await this.save(state, { stage: "OBS 已停止；YouTube 场次待结束", platformClosePending: true });
        const code = isAppError(error) ? error.code : "STOP_YOUTUBE";
        const message = "OBS 已停止推流，YouTube 场次尚未确认结束。请恢复配额或网络后重试结束，或到 YouTube Studio 核对并手动结束（未开播场次请删除）。";
        const retryAt = isAppError(error) ? error.problem?.context?.retryAt : undefined;
        throw new AppError(code, message, 502, makeProblem(code, message, { domain: "youtube", stage: "结束 YouTube 场次", outcome: "partial", ...(retryAt === undefined ? {} : { context: { retryAt } }) }));
      }
      await this.save(state, { phase: "stopped", stage: "已结束", platformClosePending: false, obsStartRequested: false, error: undefined });
    });
  }
  async clearUncertain() {
    // Only clear an ambiguous create when no identifiable broadcast exists, and OBS is confirmed inactive.
    return this.operation(async state => {
      if (state.broadcastId) throw new AppError("RECOVER", "已有明确场次，请使用结束直播完成恢复。");
      const channel = await this.youtube.channel();
      if (state.channelId && channel.id !== state.channelId) throw new AppError("CHANNEL", "请连接原 Channel。");
      const obs = await this.obs.status();
      if (obs.streaming !== false || (obs.running && !obs.ready)) throw new AppError("RECOVER", "请先确认 OBS 已停止推流且状态可读取。");
      if (state.broadcastTitle && await this.youtube.findBroadcast(state.broadcastTitle)) throw new AppError("RECOVER", "已找到原场次，请重试开始或结束直播以恢复。");
      await this.storage.write("control.json", initialState());
    });
  }
}
