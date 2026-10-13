/** 受控步骤导航：只呈现业务已允许访问的阶段，样式参考 21st.dev 的 Origin UI Stepper。 */
"use client";
/** 仅切换已有视图，并关联受控内容区域；到达某阶段不等于任务已成功完成。 */
export default function WorkflowSteps({ labels, current, reached, canNavigate, navigate, label, controls }: { labels: string[]; current: number; reached: number; canNavigate: (step: number) => boolean; navigate: (step: number) => void; label: string; controls?: string }) {
  return <ol className="ui-workflow-steps" aria-label={label}>{labels.map((name, index) => <li key={name} data-current={current === index + 1} data-reached={reached > index + 1}><button type="button" aria-label={name} aria-controls={controls} aria-current={current === index + 1 ? "step" : undefined} disabled={!canNavigate(index + 1) && current !== index + 1} onClick={() => navigate(index + 1)}><span className="ui-step-dot" aria-hidden="true">{index + 1}</span><span>{name}</span></button></li>)}</ol>;
}
