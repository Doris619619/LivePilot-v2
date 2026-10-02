/** 授权回调的短期结果引用；按原账号授权读取，不保存 OAuth code/state。 */
import "server-only";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "@/core/config";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import type { Problem } from "@/shared/problems";
import type { Member } from "./access";
import { authorizeAgent } from "./ownership";
export type OAuthResult = { target: Problem["target"]; accountId?: string; status: "connected" | "cancelled" | "failed"; problem?: Problem };
/** 短期记录仅包含安全结果，不含一次性授权凭据。 */
export async function saveOAuthResult(actor: string, result: OAuthResult) {
  const id=randomUUID(); await new Store(path.join(dataRoot(),"oauth-results")).write(id+".json",{actor,expires:Date.now()+10*60_000,result}); return id;
}
/** 不同用户或过期引用没有读取权限；设备转移后再次校验归属。 */
export async function readOAuthResult(id: string, user: Member) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError("OAUTH_RESULT","授权结果引用无效，请在原 OBS 卡片重新查询。",404);
  const store=new Store(path.join(dataRoot(),"oauth-results"));
  const record=await store.read<{actor:string;expires:number;result:OAuthResult}>(id+".json");
  if(!record || record.actor!==user.username)throw new AppError("OAUTH_RESULT","授权结果不存在或不属于当前账号。",404);
  if(record.expires<Date.now()){await store.remove(id+".json");throw new AppError("OAUTH_RESULT","授权结果提示已过期，请查询对应频道的当前状态。",410);}
  if(record.result.target.agentId)await authorizeAgent(user,record.result.target.agentId);
  return record.result;
}
