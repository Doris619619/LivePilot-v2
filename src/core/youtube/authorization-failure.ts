/** 请求实际凭据的私有错误关联；不改变公开Problem、错误正文或浏览器DTO，也不保存任何Token。 */
import { isAppError } from "../errors";
const credentials = new WeakMap<object, { generation?: string }>();
/** 只有真实授权拒绝携带实际凭据代次；undefined也表示已确认旧凭据，不能回退成较新的任务快照。 */
export function bindAuthorizationFailure<T>(error: T, generation?: string): T {
  if (isAppError(error) && ["GOOGLE_AUTH", "YOUTUBE_AUTH"].includes(error.code)) credentials.set(error, { generation });
  return error;
}
/** Runner只读取可信请求层关联，不信任任意上游错误中的同名字段。 */
export function authorizationFailureCredential(error: unknown) { return error instanceof Error ? credentials.get(error) : undefined; }
