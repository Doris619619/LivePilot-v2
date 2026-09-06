import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const content = example
  .replace(/^LIVEPILOT_OBS_EXE=.*$/m, "LIVEPILOT_OBS_EXE=")
  .replace(/^LIVEPILOT_MEDIA_ROOT=.*$/m, "LIVEPILOT_MEDIA_ROOT=")
  .replace(/^LIVEPILOT_ENCRYPTION_KEY=.*$/m, "LIVEPILOT_ENCRYPTION_KEY=" + randomBytes(32).toString("hex"));
try {
  await writeFile(new URL("../.env.local", import.meta.url), content, { flag: "wx", mode: 0o600 });
  console.log("已创建 .env.local 并生成本机加密密钥。请自行填写 OBS / Google / 媒体配置；未复制任何旧项目 Secret。");
} catch (e) {
  if (e.code === "EEXIST") console.log(".env.local 已存在，完整保留，没有覆盖。");
  else throw e;
}
