/** 空闲设备归属分配：维护锁阻挡并行直播和上传，审计保留操作人。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate, requireAdmin, members } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { listAgents, setAgentOwner } from "@/cloud/agents";
import { beginMaintenance, changeMaintenance } from "@/cloud/maintenance";
import { idSchema } from "@/shared/remote";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
export const runtime = "nodejs";
/** 只更改归属，不能以分配操作覆盖设备身份。 */
export async function POST(request: Request) {
 try { guard(request, true); const user = await authenticate(request); requireAdmin(user);
 const v = z.object({ agentId: idSchema, owner: z.string() }).strict().parse(await readJson(request));
 if (!(await members()).some(u => u.username === v.owner && u.role === "customer")) throw new AppError("OWNER", "请选择有效客户。", 400);
 const a = (await listAgents()).find(a => a.id === v.agentId && !a.pairedTo);
 if (!a) throw new AppError("AGENT", "设备不存在。", 404);
 if(a.revoked) throw new AppError("AGENT", "请先恢复电脑连接，再分配归属。", 409);
 const token = randomBytes(32).toString("hex");
 if (a.paired) await beginMaintenance(a.id, token);
 try { await setAgentOwner(a.id, v.owner, !a.paired); await audit(user.username, "assign-device", a.id, "assigned", v.owner); }
 finally { if (a.paired) await changeMaintenance(a.id, token); }
 return Response.json({ ok: true });
 } catch(e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请选择电脑和客户。") : e); }
}
