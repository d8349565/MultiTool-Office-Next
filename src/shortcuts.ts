import defaults from './defaultShortcuts.json';

export type ShortcutAction = keyof typeof defaults;
export type ShortcutBindings = Record<ShortcutAction, string | null>;
export const defaultShortcuts: ShortcutBindings = defaults;
export const shortcutLabels: Record<ShortcutAction,string> = {
  files:'文件工作区', tools:'常用工具', ocr:'文档 OCR', todo:'待办事项',
  search:'聚焦搜索', quick:'窗口内打开快捷面板', globalQuick:'全局唤起快捷面板',
};
export const shortcutText = (binding: string) => binding.replaceAll('+',' + ').replace('Space','空格');
export const ariaShortcut = (binding: string | null) => binding?.replace('Ctrl+','Control+');

export function keyboardShortcut(event: KeyboardEvent) {
  if (event.metaKey || event.getModifierState('AltGraph') || (!event.ctrlKey && !event.altKey)) return null;
  const key = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
  const suffix = key?.[1] || key?.[2] || (event.code==='Space'?'Space':null);
  return suffix ? [event.ctrlKey&&'Ctrl',event.altKey&&'Alt',event.shiftKey&&'Shift',suffix].filter(Boolean).join('+') : null;
}

export function shortcutError(action: ShortcutAction, binding: string, bindings: ShortcutBindings) {
  if (!/^(?:Ctrl\+(?:Alt\+)?|Alt\+)(?:Shift\+)?[A-Z0-9]$/.test(binding) && binding!=='Ctrl+Shift+Space') {
    return '请用 Ctrl 或 Alt 搭配字母或数字；空格仅支持 Ctrl + Shift + 空格。';
  }
  if (/^Ctrl\+(?:Shift\+)?[ACNPRSTVWXYZ]$/.test(binding)) return '这个组合键用于复制、粘贴、刷新等常用操作，请换一个。';
  if (action==='globalQuick'&&!/^Ctrl\+(?:Alt|Shift)\+/.test(binding)) return '全局快捷键请同时使用 Ctrl 和 Shift 或 Alt。';
  const conflict=(Object.keys(bindings) as ShortcutAction[]).find(key=>key!==action&&bindings[key]===binding);
  return conflict ? `${shortcutText(binding)} 已分配给“${shortcutLabels[conflict]}”，请换一个组合键。` : '';
}
