/* 文件用途：用文字和颜色共同呈现实例状态，避免只依赖颜色识别。 */



export type StatusType = "live" | "ready" | "busy" | "standby" | "error" | "stale" | "offline";

export interface StatusBadgeProps {
  status: StatusType;
  label: string;
}

/**
 * 渲染极简克制的状态药丸徽标。
 */
export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="pill-dot" />
      <span>{label}</span>
    </span>
  );
}
