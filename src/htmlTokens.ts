// Whitelist HTML tokenizer used by the translation preview.
//
// It never produces an HTML string, so nothing can be injected: output is a plain
// token tree that the renderer maps to React elements. Tags outside the whitelist
// are dropped (with their content for active ones) or unwrapped so no visible text
// is lost. This module must never throw — malformed input degrades to escaped text.

export type HtmlToken =
  | { type: 'text'; value: string }
  | { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlToken[]; start: number; end: number };

export type HtmlElement = { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlToken[]; start: number; end: number };

/** Tags rendered as real elements. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'span', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main',
  'figure', 'figcaption', 'abbr', 'address', 'time', 'details', 'summary',
]);

/** Tags whose content is discarded along with the tag itself. */
export const DROPPED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'form', 'input', 'button', 'select', 'option', 'textarea',
  'link', 'meta', 'base', 'svg', 'math', 'canvas', 'audio', 'video', 'frame', 'frameset', 'applet',
]);

const ALLOWED_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'dir', 'class', 'id']);

/** Tags that never have children, so they must not open a new stack level. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'base', 'link', 'embed', 'source', 'track', 'wbr']);

/** Tags whose content is discarded, so they still need a skip level. */
const SKIP_TAGS: ReadonlySet<string> = new Set([...DROPPED_TAGS].filter(tag => !VOID_TAGS.has(tag)));

const MAX_DEPTH = 64;

/** Opening one of these implicitly closes the still-open tags listed beside it. */
const IMPLIED_END_TAGS: Readonly<Record<string, readonly string[]>> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'],
  td: ['td', 'th'], th: ['td', 'th'], tr: ['td', 'th', 'tr'],
  div: ['p'], section: ['p'], article: ['p'], aside: ['p'], header: ['p'], footer: ['p'],
  main: ['p'], ul: ['p'], ol: ['p'], dl: ['p'], table: ['p'], pre: ['p'],
  blockquote: ['p'], figure: ['p'], hr: ['p'], details: ['p'],
  h1: ['p'], h2: ['p'], h3: ['p'], h4: ['p'], h5: ['p'], h6: ['p'],
};

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0' };

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'pre',
  'blockquote', 'hr', 'details', 'summary', 'address', 'time', 'form',
]);

/** Decodes the small entity set plus numeric references; anything else is left verbatim. */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Only http(s), mailto and relative references survive; javascript:/data: never do. */
export function safeUrl(value: string): string | null {
  // Strip whitespace and control characters so "java<TAB>script:" cannot slip through.
  const cleaned = value.replace(/[\u0000-\u0020]/g, '');
  if (!cleaned) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return cleaned; // relative reference
  return /^(https?|mailto)$/i.test(scheme[1]) ? cleaned : null;
}

const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) continue;
    // Every event handler, inline style and data-* attribute is already excluded above.
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if ((name === 'href' || name === 'src')) {
      const url = safeUrl(decodeEntities(value));
      if (url === null) continue;
      attrs[name] = url;
    } else {
      attrs[name] = decodeEntities(value);
    }
  }
  return attrs;
}

/** Finds the `>` that ends a tag, ignoring any `>` inside a quoted attribute value. */
function findTagEnd(input: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '>') return i;
  }
  return -1;
}

function emptyElement(tag: string, attrs: Record<string, string>, start: number, end: number): HtmlElement {
  return { type: 'el', tag, attrs, children: [], start, end };
}

/**
 * Tokenizes HTML into a safe tree. Unknown tags are unwrapped (children survive),
 * active tags are discarded with their content, and unclosed tags are closed at the
 * end of their parent's scope. The returned root children carry source offsets so the
 * caller can slice the original text into top-level blocks.
 */
export function tokenizeHtml(input: string): HtmlToken[] {
  const root = emptyElement('#root', {}, 0, input.length);
  const stack: HtmlElement[] = [root];
  const skip: { tag: string; depth: number }[] = [];
  let text = '';
  let i = 0;

  const top = (): HtmlElement => stack[stack.length - 1];
  const flush = () => {
    if (text) {
      top().children.push({ type: 'text', value: decodeEntities(text) });
      text = '';
    }
  };

  try {
    while (i < input.length) {
      const open = input[i];
      if (open !== '<') {
        // While inside a dropped element its body must never reach the visible tree.
        if (!skip.length) text += open;
        i++;
        continue;
      }

      // Comments, doctypes and processing instructions carry no visible text.
      if (input.startsWith('<!--', i)) {
        const close = input.indexOf('-->', i + 4);
        const end = close === -1 ? input.length : close + 3;
        i = end; continue;
      }
      if (input.startsWith('<!', i) || input.startsWith('<?', i)) {
        const end = findTagEnd(input, i);
        i = end === -1 ? input.length : end + 1;
        continue;
      }

      if (input.startsWith('</', i)) {
        const name = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(i))?.[1]?.toLowerCase();
        const end = findTagEnd(input, i);
        const after = end === -1 ? input.length : end + 1;
        if (name === undefined) { i = after; continue; }

        if (skip.length && skip[skip.length - 1].tag === name) {
          const current = skip[skip.length - 1];
          if (--current.depth === 0) skip.pop();
        } else {
          // Close the matching open tag, auto-closing anything left dangling inside it.
          let at = -1;
          for (let depth = stack.length - 1; depth > 0; depth--) {
            if (stack[depth].tag === name) { at = depth; break; }
          }
          if (at > 0) {
            flush();
            while (stack.length - 1 > at) stack.pop();
            top().end = after;
            stack.pop();
          }
        }
        i = after; continue;
      }

      const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(i))?.[1]?.toLowerCase();
      if (name === undefined) { text += '<'; i++; continue; }
      const end = findTagEnd(input, i);
      if (end === -1) { text += input.slice(i); break; }
      const after = end + 1;
      const selfClosing = input[end - 1] === '/';
      const inner = input.slice(i + 1 + name.length, selfClosing ? end - 1 : end);

      if (skip.length) { i = after; continue; }

      if (SKIP_TAGS.has(name) && !selfClosing) {
        skip.push({ tag: name, depth: 1 });
        i = after; continue;
      }
      if (DROPPED_TAGS.has(name)) { i = after; continue; }

      if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) {
        const implied = IMPLIED_END_TAGS[name];
        if (implied && top().tag !== name) {
          while (stack.length > 1 && implied.includes(top().tag)) {
            top().end = i;
            stack.pop();
          }
        }
      }

      if (ALLOWED_TAGS.has(name) && stack.length < MAX_DEPTH) {
        flush();
        const element = emptyElement(name, parseAttributes(inner), i, after);
        top().children.push(element);
        if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
      }
      // Unknown tags above the depth cap are unwrapped: children still reach the tree.

      i = after;
    }
  } catch {
    // Defensive: a tokenizer bug must still leave readable content behind.
    flush();
  }

  if (text) root.children.push({ type: 'text', value: decodeEntities(text) });
  while (stack.length > 1) { top().end = input.length; stack.pop(); }
  return root.children;
}

/** Flattens tokens to readable text, keeping block boundaries as newlines. */
export function htmlTokensToText(tokens: HtmlToken[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'text') { out += token.value; continue; }
    if (token.tag === 'br') { out += '\n'; continue; }
    const inner = htmlTokensToText(token.children);
    if (BLOCK_TAGS.has(token.tag)) out += (out && !out.endsWith('\n') ? '\n' : '') + inner + '\n';
    else out += inner;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Convenience wrapper: HTML source to readable plain text. */
export function htmlToPlainText(html: string): string {
  return htmlTokensToText(tokenizeHtml(html));
}
