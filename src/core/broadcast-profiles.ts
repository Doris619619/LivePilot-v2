/** 直播配置的原子持久化与版本冲突保护；不调用 OBS、YouTube 或上传服务。 */
import { z } from "zod";
import { Store } from "./storage";
import { AppError } from "./errors";
import { transaction } from "@/cloud/store";
import { broadcastProfileSchema, type BroadcastProfileCommand } from "@/shared/broadcast-profiles";

/** 缺文件表示首次使用；损坏数据必须显式报错，不能覆盖为空列表。 */
export async function readBroadcastProfiles(store: Store) {
  const parsed = z.array(broadcastProfileSchema).max(50).safeParse(await store.read("profiles.json") || []);
  if (!parsed.success) throw new AppError("STORAGE", "直播配置无法读取，请保留数据并联系管理员。", 500);
  return parsed.data;
}

/** 每次写入检查修订号；响应丢失后的原样重试可返回已保存结果。 */
export async function editBroadcastProfiles(store: Store, command: BroadcastProfileCommand) {
  return transaction(store, async () => {
    const profiles = await readBroadcastProfiles(store);
    const previous = profiles.find(profile => profile.id === command.id);
    if (command.action === "delete" && !previous) return profiles;
    if (command.action === "save" && previous?.revision === command.revision + 1 && previous.name === command.name && JSON.stringify(previous.selection) === JSON.stringify(command.selection)) return profiles;
    if ((previous?.revision || 0) !== command.revision) throw new AppError("REVISION", "这套直播配置已在其他页面更新，请重新读取后再保存。当前草稿已保留。", 409);
    if (command.action === "save") {
      if (profiles.some(profile => profile.id !== command.id && profile.name.toLocaleLowerCase() === command.name.toLocaleLowerCase())) throw new AppError("NAME", "已有同名直播配置，请换一个名称。", 409);
      if (!previous && profiles.length >= 50) throw new AppError("LIMIT", "最多保存 50 套直播配置，请先删除不再使用的配置。", 409);
      const next = { id: command.id, revision: command.revision + 1, name: command.name, selection: command.selection, updatedAt: Date.now() };
      if (previous) profiles.splice(profiles.indexOf(previous), 1, next); else profiles.push(next);
    } else profiles.splice(profiles.indexOf(previous!), 1);
    await store.write("profiles.json", profiles);
    return profiles;
  }, "profiles.lock");
}
