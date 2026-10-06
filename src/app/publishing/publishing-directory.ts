/** 发布目录路径展示：仅使用选中 Agent 返回的绝对路径，不猜测远程电脑的数据位置。 */
export function publishingInboxPath(root: string) {
  const directory = root.replace(/[\\/]+$/, "");
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(directory)) return "";
  return /[\\/]Inbox$/i.test(directory) ? directory : directory + (directory.includes("\\") ? "\\Inbox" : "/Inbox");
}
