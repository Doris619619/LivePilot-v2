/** 登录账号独立的视频配置目录；一次性导入旧规则，不更改旧任务、设备或频道授权。 */
import "server-only";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Member } from "./access";
import { dataRoot } from "@/core/config";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import { cloudStore, transaction } from "@/cloud/store";
import { profileSchema } from "@/shared/publishing";
import { publishingTemplate, publishingTemplateSchema, type PublishingTemplate } from "@/shared/publishing-template";

const catalogSchema = z.object({ profiles: z.array(publishingTemplateSchema), imported: z.array(z.string()) });
/** 账号身份由会话决定，即使管理员也不会隐式进入另一个客户的配置目录。 */
function storage(user: Member) { return new Store(path.join(dataRoot(), "publishing-templates", createHash("sha256").update(user.username).digest("hex"))); }
/** 导入标记与模板一起原子保存，删除或修改新模板后不会被旧文件复活或覆盖。 */
async function catalog(user: Member, save?: PublishingTemplate) {
  const store = storage(user);
  return transaction(store, async () => {
    const parsed = catalogSchema.safeParse(await store.read("templates.json") || { profiles: [], imported: [] });
    if (!parsed.success) throw new AppError("STORAGE", "视频发布配置包读取失败，请保留数据并联系管理员。", 500);
    const state = parsed.data;
    const legacy = await new Store(path.join(cloudStore().dir, "publishing")).read<{ profiles?: { owner: string; value: unknown }[] }>("state.json");
    let changed = false;
    for (const record of legacy?.profiles || []) {
      if (record.owner !== user.username) continue;
      const checked = profileSchema.safeParse(record.value);
      if (!checked.success) throw new AppError("STORAGE", "旧视频配置无法读取，请保留数据并联系管理员。", 500);
      const old = checked.data;
      if (state.imported.includes(old.id)) continue;
      if (!state.profiles.some(item => item.id === old.id)) {
        const value = publishingTemplate(old); const base = value.name; let suffix = 2;
        while (state.profiles.some(item => item.name.toLocaleLowerCase() === value.name.toLocaleLowerCase())) value.name = base.slice(0, 65) + `（迁入 ${suffix++}）`;
        state.profiles.push(value);
      }
      state.imported.push(old.id); changed = true;
    }
    if (save) {
      const previous = state.profiles.find(item => item.id === save.id);
      if (previous?.revision === save.revision && JSON.stringify(previous) === JSON.stringify(save)) return save;
      if (save.revision !== (previous?.revision || 0) + 1) throw new AppError("REVISION", "配置包已在其他页面更新，请重新读取后保存。", 409);
      if (state.profiles.some(item => item.id !== save.id && item.name.trim().toLocaleLowerCase() === save.name.trim().toLocaleLowerCase())) throw new AppError("NAME", "已有同名视频发布配置包，请换一个名称。", 409);
      if (!previous && state.profiles.length >= 200) throw new AppError("LIMIT", "视频发布配置包数量已达上限。", 409);
      state.profiles = [...state.profiles.filter(item => item.id !== save.id), save]; changed = true;
    }
    if (changed) await store.write("templates.json", state);
    return save || state.profiles;
  }, "templates.lock");
}
/** 无需设备在线或频道授权即可管理通用模板。 */
export async function readPublishingTemplates(user: Member) { return await catalog(user) as PublishingTemplate[]; }
/** 修订校验只改变模板，已确认的任务快照不会被重写。 */
export async function savePublishingTemplate(user: Member, raw: unknown) { return await catalog(user, publishingTemplateSchema.parse(raw)) as PublishingTemplate; }
