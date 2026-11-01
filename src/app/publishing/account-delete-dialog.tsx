/** 发布账号定向删除确认；只在清理请求成功后关闭，失败保留对象和可重试的安全说明。 */
"use client";
import { useRef, useState } from "react";
import type { PublishingAccount } from "@/shared/publishing";
import { SurfaceDialog } from "../components/ui/primitives";

type Props = { account?: PublishingAccount; busy: boolean; error?: string; onClose(): void; remove(id: string): Promise<void> };

/** 从未授权时只确认不可恢复；历史授权集中说明撤销及排期影响，受理不等于设备清理完成。 */
export default function AccountDeleteDialog({ account, busy, error, onClose, remove }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ accountId: string; message: string }>();
  const inFlight = useRef(false);
  const locked = busy || submitting;
  const unavailable = !account || ["cleanup_pending", "deleted"].includes(account.status);
  const hasAuthorization = !!account && (["connected", "needs_reauthorization"].includes(account.status) || !!account.channelId || !!account.connectedAt);
  const message = error || (failure?.accountId === account?.id ? failure?.message : undefined);
  const name = account?.channel || account?.name || "当前账号";
  /** 关闭清除本次失败，不把它带到之后选择的账号；在途请求继续锁定弹窗。 */
  function close() { if (!locked && !inFlight.current) { setFailure(undefined); onClose(); } }
  /** 固定点击时的账号身份并立即去重；仅成功受理后关闭，失败保留原对象供重试。 */
  async function confirm() {
    if (!account || busy || inFlight.current || unavailable) return;
    const id = account.id;
    inFlight.current = true; setSubmitting(true); setFailure(undefined);
    try { await remove(id); onClose(); }
    catch (reason) { setFailure({ accountId: id, message: reason instanceof Error && reason.message ? reason.message : "删除请求未提交，请重试。" }); }
    finally { inFlight.current = false; setSubmitting(false); }
  }
  return <SurfaceDialog open={!!account} onOpenChange={value => { if (!value) close(); }} title={"删除「" + name + "」？"} description={hasAuthorization ? "删除发布记录，并撤销 Google 授权。" : "删除后无法恢复。"} locked={locked}>
    <div className="account-dialog-content">
      {hasAuthorization && <div className="account-dialog-notes"><p>同一 Google 账号下的直播和其他频道可能需要重新授权。</p><p>已排期视频仍可能公开；YouTube 视频和本地文件保留。</p></div>}
      {message && <p className="account-manager-error" role="alert">{message}</p>}
      <div className="account-dialog-actions"><button type="button" className="btn-secondary" disabled={locked} onClick={close}>取消</button><button type="button" className="btn-danger" disabled={locked || unavailable} onClick={() => void confirm()}>{submitting ? "正在删除…" : "删除账号"}</button></div>
    </div>
  </SurfaceDialog>;
}
