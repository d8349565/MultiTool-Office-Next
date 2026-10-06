// Format detection and block segmentation for the translation page.
//
// Blocks are the unit of both rendering and scroll/selection sync: each block is
// independently renderable (a heading, a paragraph, a list, a table, a code fence or
// a top-level HTML element), so the same function serves the preview and the mapping
// between the two panes. Block ranges always tile the input exactly — concatenating
// every block slice reproduces the original text byte for byte.

import { tokenizeHtml, type HtmlToken } from './htmlTokens';

export type SourceFormat = 'plain' | 'markdown' | 'html';
export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'html-block';

export type Block = { index: number; start: number; end: number; kind: BlockKind };

export const FORMAT_LABELS: Readonly<Record<SourceFormat, string>> = {
  plain: '纯文本', markdown: 'Markdown', html: '网页 HTML',
};

const HTML_HINT = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<div[\s>]|<p[\s/>]|<span[\s>]|<table[\s>]|<br\s*\/?>|<a\s+href|<ul[\s>]|<ol[\s>]|<section[\s>]|<h[1-6][\s>]/i;
const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/gi;
const MARKDOWN_HINT = [
  /^#{1,6}\s/m, /^\s{0,3}[-*+]\s+/m, /^\s{0,3}\d+[.)]\s+/m,
  /^```/m, /^\s*\|.*\|\s*$/m, /\[[^\]\n]+\]\([^)\n]+\)/, /\*\*[^*\n]+\*\*/, /^>\s/m,
];

/** Detects whether the pasted text is plain prose, Markdown or a web page. */
export function detectFormat(text: string): SourceFormat {
  // A leading slice is enough signal and keeps detection cheap while typing.
  const sample = text.slice(0, 20000);
  if (!sample.trim()) return 'plain';
  let fence: string | null = null, hasFence = false;
  const outsideCode = sample.split('\n').map(line => {
    const marker = FENCE_OPEN.exec(line.trimStart())?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return '';
    }
    if (marker) { fence = marker; hasFence = true; return ''; }
    return line;
  }).join('\n');
  if (HTML_HINT.test(outsideCode) || (outsideCode.match(HTML_TAG)?.length ?? 0) >= 3) return 'html';
  return hasFence || MARKDOWN_HINT.some(pattern => pattern.test(sample)) ? 'markdown' : 'plain';
}

type Line = { start: number; end: number; value: string };

function toLines(text: string): Line[] {
  const rows: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { rows.push({ start, end: i + 1, value: text.slice(start, i + 1) }); start = i + 1; }
  }
  if (start < text.length) rows.push({ start, end: text.length, value: text.slice(start) });
  return rows;
}

function classify(line: string): BlockKind {
  if (/^#{1,6}\s/.test(line)) return 'heading';
  if (/^\s*\|.*\|\s*$/.test(line)) return 'table';
  if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) return 'list';
  return 'paragraph';
}

const FENCE_OPEN = /^(`{3,}|~{3,})/;

function segmentMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  // Start of the blank run that follows the last block, so no characters fall between blocks.
  let pending: number | null = null;
  let fence: string | null = null;
  let afterBlank = false;

  for (const row of toLines(text)) {
    const trimmed = row.value.trim();

    if (fence) {
      // A fenced code block is one unit: it is never split, even when unterminated.
      current!.end = row.end;
      if (trimmed.startsWith(fence)) { fence = null; blocks.push(current!); current = null; }
      continue;
    }
    if (!trimmed) {
      // A blank line ends the block above; with no block open it leads the next one.
      if (current) current.end = row.end;
      else if (pending === null) pending = row.start;
      afterBlank = true;
      continue;
    }

    const marker = FENCE_OPEN.exec(trimmed)?.[1];
    const kind: BlockKind = marker ? 'code' : classify(trimmed);
    // Headings and fences always stand alone; lists, tables and paragraphs merge only
    // with their own kind, and a blank line always forces a new block.
    if (!current || afterBlank || kind === 'heading' || kind === 'code' || current.kind !== kind) {
      if (current) blocks.push(current);
      current = { index: 0, start: pending ?? row.start, end: row.end, kind };
      pending = null;
      afterBlank = false;
    } else {
      current.end = row.end;
    }
    if (marker) fence = marker;
  }
  if (current) blocks.push(current);
  if (blocks.length) blocks[blocks.length - 1].end = text.length;
  return blocks;
}

function segmentPlain(text: string): Block[] {
  const blocks: Block[] = [];
  let start = 0;
  for (const row of toLines(text)) {
    if (!row.value.trim()) {
      if (blocks.length) blocks[blocks.length - 1].end = row.end;
      continue;
    }
    blocks.push({ index: blocks.length, start, end: row.end, kind: 'paragraph' });
    start = row.end;
  }
  // 空行属于前一个段落，下一段从空行之后开始。
  for (let i = 1; i < blocks.length; i++) blocks[i].start = blocks[i - 1].end;
  return blocks;
}

const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'pre', 'blockquote', 'hr', 'details', 'address',
]);

function segmentHtml(html: string): Block[] {
  const blocks: Block[] = [];
  let start = 0;
  for (const node of tokenizeHtml(html) as HtmlToken[]) {
    if (node.type !== 'el' || !HTML_BLOCK_TAGS.has(node.tag)) continue;
    if (node.end > start) blocks.push({ index: 0, start, end: node.end, kind: 'html-block' });
    start = node.end;
  }
  if (html.length > start) {
    if (blocks.length) blocks[blocks.length - 1].end = html.length;
    else blocks.push({ index: 0, start: 0, end: html.length, kind: 'html-block' });
  }
  return blocks;
}

/** Splits text into contiguous render/sync units. Concatenating the slices returns the input. */
export function segmentBlocks(text: string, format: SourceFormat): Block[] {
  const blocks = format === 'html' ? segmentHtml(text) : format === 'plain' ? segmentPlain(text) : segmentMarkdown(text);
  return blocks.map((block, index) => ({ ...block, index }));
}

/**
 * 段数不同不能推断对应关系，返回 -1 表示无法可靠定位。
 */
export function alignBlocks(sourceCount: number, targetCount: number): number[] {
  if (sourceCount <= 0) return [];
  if (sourceCount === targetCount) return Array.from({ length: sourceCount }, (_, i) => i);
  return new Array<number>(sourceCount).fill(-1);
}

function htmlStructure(tokens: HtmlToken[]): string {
  return tokens.map(token => token.type === 'text' ? ''
    : `${token.tag}[${token.attrs.colspan || ''},${token.attrs.rowspan || ''}](${htmlStructure(token.children)})`).join('');
}

function structure(text: string, block: Block, format: SourceFormat): string {
  const value = text.slice(block.start, block.end).trim();
  if (format === 'html') return htmlStructure(tokenizeHtml(value));
  if (format === 'plain') return 'paragraph';
  if (block.kind === 'heading') return /^#{1,6}/.exec(value)?.[0] || '';
  if (block.kind === 'code') return value;
  if (block.kind === 'list') return value.split('\n').map(line => /^\s{0,3}([-*+]|\d+[.)])\s+/.exec(line)?.[1] || '').join('|');
  if (block.kind === 'table') return value.split('\n').filter(line => line.trim()).map(line => line.split('|').length).join('|');
  return block.kind;
}

export type BlockAlignment = { forward: number[]; backward: number[]; reliable: boolean };

/** 高亮和滚动使用同一套经过格式与结构校验的段落对应关系。 */
export function alignTranslationBlocks(source: string, target: string, sourceFormat: SourceFormat, targetFormat: SourceFormat,
  sourceBlocks: Block[], targetBlocks: Block[]): BlockAlignment {
  const reliable = sourceFormat === targetFormat && sourceBlocks.length > 0 && sourceBlocks.length === targetBlocks.length &&
    sourceBlocks.every((block, i) => block.kind === targetBlocks[i].kind &&
      structure(source, block, sourceFormat) === structure(target, targetBlocks[i], targetFormat));
  return {
    forward: reliable ? alignBlocks(sourceBlocks.length, targetBlocks.length) : sourceBlocks.map(() => -1),
    backward: reliable ? alignBlocks(targetBlocks.length, sourceBlocks.length) : targetBlocks.map(() => -1),
    reliable,
  };
}

export function mapBlockRange(range: [number, number] | null, mapping: number[]): [number, number] | null {
  if (!range || range[0] < 0 || range[1] >= mapping.length || range[1] < range[0]) return null;
  const selected = mapping.slice(range[0], range[1] + 1);
  return selected.some(index => index < 0) ? null : [selected[0], selected[selected.length - 1]];
}

/** Resolves a character range to the inclusive block range it touches, or null. */
export function selectionToBlocks(blocks: Block[], start: number, end: number): [number, number] | null {
  if (!blocks.length || end <= start) return null;
  let first = -1;
  let last = -1;
  for (const block of blocks) {
    if (block.end <= start || block.start >= end) continue;
    if (first === -1) first = block.index;
    last = block.index;
  }
  return first === -1 || last === -1 ? null : [first, last];
}

/** Closes a dangling code fence the model dropped. Reports whether anything was changed. */
export function balanceFences(text: string): { text: string; repaired: boolean } {
  let fence: string | null = null;
  for (const row of toLines(text)) {
    const trimmed = row.value.trim();
    if (!fence) { fence = FENCE_OPEN.exec(trimmed)?.[1] ?? null; continue; }
    if (trimmed.startsWith(fence)) fence = null;
  }
  if (!fence) return { text, repaired: false };
  return { text: `${text.replace(/\s*$/, '')}\n${fence}\n`, repaired: true };
}
