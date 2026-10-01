/** YouTube 元数据使用 Unicode 码点和 UTF-8 字节计数，不能用 UTF-16 长度代替官方字段规则。 */
import { z } from "zod";
/** 计数 Unicode 码点；组合字素可能包含多个码点，Phase 0 仍需真实 API 校准。 */
export function titleCharacters(value: string) { return Array.from(value).length; }
/** 浏览器和 Agent 共用 UTF-8 描述计数。 */
export function descriptionBytes(value: string) { return new TextEncoder().encode(value).byteLength; }
/** 拒绝无法编码的孤立代理项和 YouTube 不允许的尖括号。 */
function validText(value: string) { return value.isWellFormed() && !/[<>]/u.test(value); }
export const videoTitleSchema = z.string().refine(v => !!v.trim(), "请填写标题").refine(validText, "标题包含无效字符或尖括号").refine(v => titleCharacters(v) <= 100, "标题最多 100 个 Unicode 字符");
export const videoDescriptionSchema = z.string().refine(validText, "说明包含无效字符或尖括号").refine(v => descriptionBytes(v) <= 5000, "说明最多 5000 个 UTF-8 字节");
/** 官方 Tags 总长度包括分隔逗号及含空格标签的引号。 */
export function tagCharacters(tags: string[]) { return tags.reduce((n, t) => n + titleCharacters(t) + (t.includes(" ") ? 2 : 0), Math.max(0, tags.length - 1)); }
export const videoTagsSchema = z.array(z.string().min(1).refine(validText)).max(500).refine(v => tagCharacters(v) <= 500, "Tags 总长度最多 500 个字符");
export const videoCopySchema = z.object({ title: videoTitleSchema, description: videoDescriptionSchema }).strict();
