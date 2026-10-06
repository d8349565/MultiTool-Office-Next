// Measures where each character sits inside a <textarea>.
//
// A textarea exposes no per-line geometry, so scroll sync cannot tell which block is
// at the top of the source pane. A hidden mirror styled identically to the field gives
// us the real position of any character through a DOM Range, which keeps block
// anchoring exact while the user is still editing plain text.

const COPIED_PROPERTIES = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
] as const;

export type TextAnchor = { offset: number; delta: number };

export type TextareaMirror = {
  /** Character offset just below the top of the visible area, and its offset from the viewport top. */
  anchorAt(scrollTop: number): TextAnchor;
  /** 字符所在行相对于文本内容顶部的位置，供双向段落定位使用。 */
  topAt(offset: number): number;
  refresh(text: string): void;
  dispose(): void;
};

export function createTextareaMirror(field: HTMLTextAreaElement): TextareaMirror {
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  const style = getComputedStyle(field);
  for (const property of COPIED_PROPERTIES) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'absolute', top: '0', left: '0', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${field.clientWidth}px`,
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word',
  });
  const node = document.createTextNode('\u200b');
  mirror.appendChild(node);
  document.body.appendChild(mirror);

  let length = 0;

  const refresh = (text: string) => {
    length = text.length;
    node.data = length ? text : '\u200b';
    mirror.style.width = `${field.clientWidth}px`;
  };

  const topAt = (offset: number) => {
    const origin = mirror.getBoundingClientRect().top;
    if (!length) return parseFloat(mirror.style.paddingTop) || 0;
    const at = Math.max(0, Math.min(offset, length - 1));
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = range.getBoundingClientRect();
    return (offset >= length ? rect.bottom : rect.top) - origin;
  };

  return {
    refresh,
    topAt,
    /** Binary search over character offsets: line tops are monotonic in a pre-wrap flow. */
    anchorAt(scrollTop: number): TextAnchor {
      if (!length) return { offset: 0, delta: 0 };
      const origin = mirror.getBoundingClientRect().top;
      const targetY = origin + scrollTop;
      if (targetY <= origin) return { offset: 0, delta: 0 };
      let low = 0;
      let high = length;
      while (low < high) {
        const mid = (low + high) >> 1;
        const range = document.createRange();
        range.setStart(node, mid);
        range.setEnd(node, Math.min(mid + 1, length));
        const rect = range.getBoundingClientRect();
        if (rect.height === 0 || rect.top <= targetY) low = mid + 1;
        else high = mid;
      }
      const offset = Math.min(low, Math.max(0, length - 1));
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + 1, length));
      const rect = range.getBoundingClientRect();
      return { offset, delta: (rect.height ? rect.top : origin) - (origin + scrollTop) };
    },
    dispose() { mirror.remove(); },
  };
}
