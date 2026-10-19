/** 文件用途：为网页 AI 互动的功能面板提供统一线宽的语义图标，不引入全局图标或样式变更。 */
const shapes = {
  power: <><path d="M12 3v9" /><path d="M6.3 5.8a8 8 0 1 0 11.4 0" /></>,
  persona: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" /></>,
  behavior: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z" /><path d="M7 10h10M7 14h6" /></>,
  identity: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="10" r="2" /><path d="M5 16a3 3 0 0 1 6 0M14 9h4M14 13h4" /></>,
  style: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
  trial: <><rect x="3" y="3" width="18" height="15" rx="3" /><path d="m8 18-3 4v-4M8 9h.01M12 9h.01M16 9h.01" /></>,
};

/** 图标仅辅助面板标题辨认；隐藏于读屏树，避免重复朗读可见标题。 */
export default function BroadcastChatIcon({ name }: { name: keyof typeof shapes }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
