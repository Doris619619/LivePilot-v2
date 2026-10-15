/** 表单长度计数：调用方决定字符或字节算法，统一右对齐与临界/超限反馈。 */
export default function FieldCounter({ id, count, limit, unit = "字符" }: { id: string; count: number; limit: number; unit?: "字符" | "字节" }) {
  const exceeded = count > limit;
  return <span id={id} className={`field-counter${exceeded ? " is-error" : count >= limit * 0.9 ? " is-warning" : ""}`}>
    <span aria-hidden="true">{exceeded ? `超出 ${count - limit} ${unit} · ` : ""}{count}/{limit}{unit === "字节" ? " 字节" : ""}</span>
    <span className="visually-hidden">已输入 {count} {unit}，最多 {limit} {unit}{exceeded ? `，超出 ${count - limit} ${unit}` : ""}</span>
  </span>;
}
