/** 将小型封面保存到目标 Agent 的实例目录，上传原始数据不进入心跳。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { thumbnailInputSchema } from "@/shared/broadcast";
import { Store } from "./storage";
import { AppError } from "./errors";

type Thumbnail = z.infer<typeof thumbnailInputSchema>;
/** 校验格式、大小和文件签名；存储名只由服务生成，与用户文件名无关。 */
export async function saveThumbnail(storage: Store, input: Thumbnail) {
  const value = thumbnailInputSchema.parse(input);
  const bytes = Buffer.from(value.data, "base64");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!bytes.length || bytes.length > 2 * 1024 ** 2 || (value.mime === "image/png" ? !png : !jpeg)) throw new AppError("INPUT", "请选择不超过 2 MB 的 PNG 或 JPG 图片。");
  const id = randomUUID();
  await storage.write("thumbnail-" + id + ".json", value);
  return { id, name: value.name };
}
/** 只读取当前实例拥有的 UUID 封面，拒绝路径和缺失文件。 */
export async function readThumbnail(storage: Store, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError("INPUT", "封面标识无效。");
  const value = await storage.read<Thumbnail>("thumbnail-" + id + ".json");
  if (!value) throw new AppError("INPUT", "该实例的封面已不存在，请重新上传。");
  return thumbnailInputSchema.parse(value);
}
