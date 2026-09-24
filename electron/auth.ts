/** 桌面账号统一在云端校验；客户会话仅驻留主进程，不保存密码。 */
import { AppError } from "../src/core/errors";
import type { Settings } from "./settings";
import { problemSchema } from "../src/shared/problems";
import { DESKTOP_ORIGIN } from "../src/shared/desktop";
type Customer = { username: string; role: "customer" };
type Requester = (url: string, init?: RequestInit) => Promise<Response>;
export class DesktopAuth {
 private token = ""; private user?: Customer; private expires = 0; private checked = 0; private checkedAgent?: string;
 /** 请求实现由 Electron Session 注入，沿用 Windows 代理。 */
 constructor(private request: Requester = fetch) {}
 /** 公开状态不含令牌；过期会话立即锁定界面。 */
 session() { if (this.expires <= Date.now()) this.clear(); return { authenticated: !!this.user, username: this.user?.username }; }
 /** 主进程经云端验证角色；错误仅回显安全 API 消息。 */
 async login(username: unknown, password: unknown) {
  if(typeof username !== "string" || typeof password !== "string" || username.length > 32 || password.length > 256) return {ok:false,message:"请输入有效账号和密码。"};
  this.clear();
  try { const response = await this.request(DESKTOP_ORIGIN+"/api/desktop/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password}),redirect:"error",signal:AbortSignal.timeout(15000)}); const result = await response.json();
   if(!response.ok) return {ok:false,message:result.error||"登录失败，请重试。"};
   if(result.user?.role!=="customer" || !/^[a-f0-9]{64}$/.test(result.token) || !Number.isFinite(result.expires)) return {ok:false,message:"管理员请使用管理员网页端。"};
   this.user=result.user;this.token=result.token;this.expires=result.expires; return {ok:true};
  } catch {return {ok:false,message:"无法连接登录服务，请检查网络后重试。离线帮助仍可查看。"};}
 }
 /** 清理界面会话与远程令牌，不停止 Agent。 */
 async logout() { const token=this.token;this.clear(); if(token) await this.request(DESKTOP_ORIGIN+"/api/desktop/session",{method:"DELETE",headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)}).catch(()=>{}); }
 /** 每次敏感操作重查角色及设备归属，状态轮询最多缓存 10 秒。 */
 async require(agentId?:string, fresh=true) {
  if(!this.session().authenticated) throw new AppError("AUTH", "登录已失效，请重新登录。已有直播继续运行。");
  if(!fresh && this.checkedAgent===agentId && Date.now()-this.checked<10000)return;
  let response:Response;
  try { response=await this.request(DESKTOP_ORIGIN+"/api/desktop/session"+(agentId?"?agentId="+encodeURIComponent(agentId):""),{headers:{Authorization:"Bearer "+this.token},redirect:"error",signal:AbortSignal.timeout(10000)}); }catch{throw new AppError("CLOUD_NETWORK", "无法验证客户会话，请检查网络；已有直播继续运行。");}
  if(!response.ok){
   await response.body?.cancel();
   if(response.status===401){this.clear();throw new AppError("AUTH","登录已失效，请重新登录。",401);}
   if(response.status===403)throw new AppError("FORBIDDEN","这台电脑尚未分配给当前客户，请联系管理员。",403);
   throw new AppError("CLOUD_UNAVAILABLE","客户会话暂时无法验证，原登录记录保留。请稍后重新验证；已有直播继续运行。",503);
  }
  await response.body?.cancel();this.checked=Date.now();this.checkedAgent=agentId;
 }
 /** 核对当前客户和原设备证明；只接受明确的删除响应，不从 401/403 推断删除。 */
 async binding(identity: NonNullable<Settings["identity"]>, remove = false): Promise<"active" | "deleted"> {
  const token = this.token;
  const headers = this.headers();
  let response: Response;
  try { response = await this.request(DESKTOP_ORIGIN + "/api/desktop/binding", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: identity.agentId, token: identity.token, remove }), redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError("CLOUD_NETWORK", "暂时无法核对设备绑定，原配置已保留。请检查网络后重新读取。"); }
  if (this.token !== token || !this.session().authenticated) throw new AppError("AUTH", "登录已变化，请重新读取状态。", 401);
  const body = await response.json().catch(() => null);
  if (response.status === 401) { this.clear(); throw new AppError("AUTH", "登录已失效，请重新登录。", 401); }
  if (!response.ok) {
   const parsed = problemSchema.safeParse(body?.problem);
   if (parsed.success) throw new AppError(parsed.data.code, parsed.data.message, response.status, parsed.data);
   throw new AppError(response.status === 403 ? "FORBIDDEN" : "CLOUD_UNAVAILABLE", response.status === 403 ? "当前客户无权访问这台电脑，请核对登录账号。" : "云端暂时无法核对设备绑定，请稍后重新读取；原配置已保留。", response.status);
  }
  if (body?.status !== "active" && body?.status !== "deleted") throw new AppError("DESKTOP_IPC", "设备绑定响应无效，原配置已保留。请重新读取。");
  return body.status;
 }
 /** 配对请求携带客户会话，禁止 UI 接触原始令牌。 */
 headers() { if(!this.session().authenticated)throw new AppError("AUTH", "请先登录客户账号。");return {Authorization:"Bearer "+this.token}; }
 /** 会话清理不触碰设备身份。 */
 private clear(){this.token="";this.user=undefined;this.expires=0;this.checked=0;this.checkedAgent=undefined;}
}
