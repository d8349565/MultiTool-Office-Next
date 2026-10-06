// Renders whitelisted HTML tokens as React elements.
//
// The tokenizer has already removed every unsafe tag, attribute and URL scheme, so
// this layer is a plain lookup: no innerHTML, no dangerouslySetInnerHTML, nothing that
// could turn pasted markup into live DOM.

import { createElement, type ReactNode } from 'react';
import { tokenizeHtml, type HtmlToken } from './htmlTokens';

const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'col']);

/** Keeps a hostile colspan from stretching a table across the screen. */
function span(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(1000, parsed)) : undefined;
}

function renderTokens(tokens: HtmlToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, i) => {
    if (token.type === 'text') return token.value;
    const key = `${keyPrefix}-${i}`;
    if (token.tag === 'br') return <br key={key}/>;
    if (token.tag === 'hr') return <hr key={key}/>;
    // 预览只展示图片说明，避免粘贴内容触发外部或本地资源请求。
    if (token.tag === 'img') return <span key={key}>{token.attrs.alt ? `[图片：${token.attrs.alt}]` : '[图片]'}</span>;

    const attrs = token.attrs;
    const props: Record<string, unknown> = { key };
    if (attrs.class) props.className = attrs.class;
    if (attrs.id) props.id = attrs.id;
    if (attrs.lang) props.lang = attrs.lang;
    if (attrs.dir) props.dir = attrs.dir;
    if (attrs.title) props.title = attrs.title;

    if (token.tag === 'a' && attrs.href) {
      props.href = attrs.href;
      props.target = '_blank';
      props.rel = 'noreferrer noopener';
    }
    if (token.tag === 'td' || token.tag === 'th') {
      const colSpan = span(attrs.colspan);
      const rowSpan = span(attrs.rowspan);
      if (colSpan !== undefined) props.colSpan = colSpan;
      if (rowSpan !== undefined) props.rowSpan = rowSpan;
    }

    const children = VOID_TAGS.has(token.tag) ? undefined : renderTokens(token.children, key);
    return createElement(token.tag, props, children);
  });
}

/** Renders a fragment of pasted HTML with formatting intact and scripts removed. */
export function TranslateHtml({text}:{text:string}) {
  return <div className="translate-html">{renderTokens(tokenizeHtml(text), 'h')}</div>;
}
