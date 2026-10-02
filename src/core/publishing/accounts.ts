/** Agent 独立发布账号的加密 OAuth、频道确认和清理记录；与任何直播实例授权目录隔离。 */
import path from "node:path";
import { readdir } from "node:fs/promises";
import { dataRoot, requireInstance } from "../config";
import { seal } from "../storage";
import { AppError } from "../errors";
import { YouTubeAuth } from "../youtube/auth";
import { YouTubeApi } from "../youtube/api";
import { PublishingStore } from "./storage";

type Record = { id: string; instanceId: string; channelId?: string; channel?: string; connectedAt?: number; channelCheckedAt?: number; channelAttemptAt?: number; deleted?: boolean; purge?: { createdAt: number; pending: boolean } };
export type PublishingAccountStatus = { id: string; instanceId: string; channelId?: string; channel?: string; connectedAt?: number; channelCheckedAt?: number; cleanupPending?: boolean };
type Binding = (id: string, instanceId: string, channel: { channelId: string; channel: string; channelCheckedAt?: number }, confirm: boolean) => Promise<void>;
const accountId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** UUID 是服务端创建的账号身份，禁止使用路径字符或让浏览器提供存储路径。 */
export function requirePublishingAccount(id: string) { if (!accountId.test(id)) throw new AppError("ACCOUNT", "发布账号不存在。", 404); return id.toLowerCase(); }

export class PublishingAccounts {
  private auths = new Map<string, YouTubeAuth>(); private operations = new Map<string, Promise<unknown>>();
  readonly root: string;
  /** 只保存公开频道身份到 Cloud；令牌在永久占位成功后于账号专属目录原子加密落盘。 */
  constructor(private bind: Binding, root = path.join(dataRoot(), "agent", "publishing", "accounts")) { this.root = path.resolve(root); }
  /** 固定账号的发布存储目录；宿主实例只用于设备路由与旧素材/AI设置。 */
  store(id: string) { return new PublishingStore(path.join(this.root, requirePublishingAccount(id))); }
  /** 同账号授权、清理按顺序执行，不阻塞其他发布账号或直播控制。 */
  private run<T>(id: string, action: () => Promise<T>): Promise<T> { id = requirePublishingAccount(id); const operation = (this.operations.get(id) || Promise.resolve()).catch(() => {}).then(action); this.operations.set(id, operation); void operation.finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); }).catch(() => {}); return operation; }
  /** 创建并固定账号宿主；重启、重连不能把同一 UUID 路由到另一实例。 */
  private async record(id: string, instanceId?: string): Promise<Record> {
    id = requirePublishingAccount(id); const store = this.store(id); const saved = await store.read<Record>("account.json");
    if (saved) { if (instanceId && saved.instanceId !== instanceId) throw new AppError("ACCOUNT", "发布账号所属设备实例不能改变。", 409); return saved; }
    if (!instanceId) throw new AppError("ACCOUNT", "请先连接这个发布账号。", 404);
    const created = { id, instanceId: requireInstance(instanceId) }; await store.write("account.json", created); return created;
  }
  /** 账号必须未在清理；清理记录跨进程保留，不能因网络断开重新启用旧授权。 */
  async assertAvailable(id: string, instanceId?: string, acceptedAt?: number) { const record = await this.record(id, instanceId); if (record.deleted) throw new AppError("ACCOUNT_DELETED", "这个发布账号已删除，请新建发布账号。", 409); if (record.purge?.pending) throw new AppError("CLEANUP", "这个发布账号正在清理授权。", 409); if (record.purge && acceptedAt !== undefined && acceptedAt <= record.purge.createdAt) throw new AppError("CONSENT", "这个发布账号的旧发布授权已撤销，请重新确认批次。", 409); return record; }
  /** Auth 固定使用独立目录与 state 前缀；此处不读取或保存宿主直播 Token。 */
  auth(id: string) {
    id = requirePublishingAccount(id); let auth = this.auths.get(id); if (auth) return auth;
    const store = this.store(id);
    auth = new YouTubeAuth(store, "publishing-" + id, async tokens => {
      const record = await this.assertAvailable(id);
      if (record.channelId && record.channelId !== tokens.channelId) throw new AppError("CHANNEL", "请重新授权这个发布账号原来的频道。", 409);
      const channelCheckedAt = Date.now();
      await this.bind(id, record.instanceId, { channelId: tokens.channelId, channel: tokens.channel, channelCheckedAt }, false);
      await store.write("youtube.enc", seal(tokens));
      await store.write("account.json", { ...record, channelId: tokens.channelId, channel: tokens.channel, connectedAt: Date.now(), channelCheckedAt });
      await this.bind(id, record.instanceId, { channelId: tokens.channelId, channel: tokens.channel, channelCheckedAt }, true);
    });
    this.auths.set(id, auth); return auth;
  }
  /** 开始独立发布 OAuth；actor 和账号身份保存在一次性加密 PKCE 事务中。 */
  begin(id: string, instanceId: string, actor: string) { return this.run(id, async () => { await this.assertAvailable(id, instanceId); return this.auth(id).begin(actor); }); }
  /** 重连固定原频道，已有会话的任务还提供期望频道；失败不会覆盖旧 Token。 */
  finish(id: string, instanceId: string, cookie: string, state: string, code: string, actor: string, expectedChannel?: string, cancelled = false) {
    return this.run(id, async () => { const record = await this.assertAvailable(id, instanceId); if (record.channelId && expectedChannel && record.channelId !== expectedChannel) throw new AppError("CHANNEL", "发布任务和账号原频道不一致。", 409); await this.auth(id).finish(cookie, state, code, record.channelId || expectedChannel, actor, cancelled); return { ok: true }; });
  }
  /** 播放列表请求复用短 API 客户端，但授权只来自该发布账号。 */
  playlists(id: string, instanceId: string) { return this.run(id, async () => { await this.assertAvailable(id, instanceId); return { playlists: await new YouTubeApi(this.auth(id), this.store(id)).playlists() }; }); }
  /** 频道标题只由真实查询续期；直接更新缓存而不调用 saveBinding，避免同账号队列重入；失败满30天清除标题。 */
  private refreshMetadata(id: string) { return this.run(id, async () => {
    const store = this.store(id); let record = await this.record(id); const checkedAt = record.channelCheckedAt ?? record.connectedAt ?? 0; const now = Date.now();
    if (record.deleted || record.purge?.pending || !await this.auth(id).tokens()) return;
    if (checkedAt > now - 25 * 86400_000 && record.channel) return;
    if (!record.channelAttemptAt || record.channelAttemptAt <= now - 1800_000) {
      record.channelAttemptAt = now; await store.write("account.json", record);
      try {
        const channel = await new YouTubeApi(this.auth(id), store).channel();
        await store.exclusive(async () => { const token = await this.auth(id).tokens(); if (!token || channel.id !== token.channelId || record.channelId && channel.id !== record.channelId) throw new AppError("CHANNEL", "频道查询结果与这个发布账号不一致。", 409); await store.write("youtube.enc", seal({ ...token, channel: channel.title })); record = { ...record, channelId: channel.id, channel: channel.title, channelCheckedAt: Date.now() }; await store.write("account.json", record); }, "tokens.lock");
        return;
      } catch { /* 保留原频道身份；网络失败不伪造API刷新时间，也不输出上游诊断。 */ }
    }
    if (checkedAt <= now - 30 * 86400_000) { await store.exclusive(async () => { const token = await this.auth(id).tokens(); if (token?.channel) await store.write("youtube.enc", seal({ ...token, channel: "" })); delete record.channel; await store.write("account.json", record); }, "tokens.lock"); }
  }); }
  /** 本机只上报频道公开身份与清理状态，不把 OAuth 事务或凭据传给浏览器。 */
  async statuses(): Promise<PublishingAccountStatus[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; }); const values: PublishingAccountStatus[] = [];
    for (const entry of entries) if (entry.isDirectory() && accountId.test(entry.name)) { await this.refreshMetadata(entry.name); const record = await this.record(entry.name); const token = await this.auth(entry.name).tokens(); values.push({ id: record.id, instanceId: record.instanceId, ...(token && !record.purge?.pending && !record.deleted ? { channelId: token.channelId, ...(record.channel && token.channel ? { channel: record.channel } : {}), connectedAt: record.connectedAt, channelCheckedAt: record.channelCheckedAt ?? record.connectedAt } : {}), ...(record.purge?.pending || record.deleted && token ? { cleanupPending: true } : {}) }); }
    return values;
  }
  /** Cloud 重连时恢复本机已落盘的账号确认，不重复 OAuth，也不触碰直播绑定。 */
  async register() { for (const status of await this.statuses()) if (status.channelId && status.channel) await this.bind(status.id, status.instanceId, { channelId: status.channelId, channel: status.channel, channelCheckedAt: status.channelCheckedAt }, true); }
  /** 先持久禁止新授权和任务；清理中断后仍由同一请求继续。 */
  startCleanup(id: string, instanceId: string, createdAt: number) { return this.run(id, async () => { const record = await this.record(id, instanceId); await this.store(id).write("account.json", { ...record, purge: { createdAt: Math.max(createdAt, record.purge?.createdAt || 0), pending: true } }); }); }
  /** 仅撤销该发布账号并清除频道观察数据，保留本地源素材及其他账号。 */
  revoke(id: string) { return this.run(id, async () => { const record = await this.record(id); if (!record.purge?.pending) throw new AppError("CLEANUP", "清理请求尚未持久化。", 409); await this.auth(id).revoke(); delete record.channelId; delete record.channel; delete record.connectedAt; delete record.channelCheckedAt; delete record.channelAttemptAt; await this.store(id).write("account.json", record); }); }
  /** 只有 Cloud 接收清理确认后完成本机标记，旧同意时间继续受 tombstone 保护。 */
  completeCleanup(id: string) { return this.run(id, async () => { const record = await this.record(id); if (record.purge) { record.purge.pending = false; record.deleted = true; await this.store(id).write("account.json", record); } }); }
  /** 维护期间不打断正在交换、落盘或撤销的账号授权操作。 */
  get busy() { return this.operations.size > 0; }
  /** Agent 退出前等待短授权/清理完成；上传由 PublishingRunner 自行安全停止。 */
  async drain() { await Promise.allSettled([...this.operations.values()]); }
}
