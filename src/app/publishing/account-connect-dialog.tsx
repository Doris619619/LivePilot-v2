/** 发布账号连接确认弹窗；只调用所属工作台的连接动作，不自行创建账号或保存授权。 */
"use client";
import { SurfaceDialog } from "../components/ui/primitives";

type Props = { open: boolean; busy: boolean; blocked?: boolean; error?: string; retry: boolean; onClose(): void; connect(): void };

/** 设备或同意状态阻止连接时仍可取消；真正提交期间锁定关闭，错误由账号流程提供。 */
export default function AccountConnectDialog({ open, busy, blocked = false, error, retry, onClose, connect }: Props) {
  /** Escape、遮罩和取消共用关闭边界，不中断已发出的连接请求。 */
  function close() { if (!busy) onClose(); }
  /** 用户明确确认后才进入所属账号的连接流程，防止受阻或忙碌时重复触发。 */
  function begin() { if (!busy && !blocked) connect(); }
  return <SurfaceDialog open={open} onOpenChange={value => { if (!value) close(); }} title="连接 YouTube 频道" description="在 Google 页面选择要连接的账号和频道。" locked={busy}>
    <div className="account-dialog-content">
      {error && <p className="account-manager-error" role="alert">{error}</p>}
      <div className="account-dialog-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={close}>取消</button><button type="button" className="btn-primary" disabled={busy || blocked} onClick={begin}>{busy ? "正在打开授权…" : retry ? "重试连接频道" : "连接频道"}</button></div>
    </div>
  </SurfaceDialog>;
}
