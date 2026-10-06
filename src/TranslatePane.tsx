// The two panes of the translation page, plus the machinery that keeps them aligned.
//
// Scroll sync and selection sync both work off the block index produced by
// `segmentBlocks`, so a block means the same thing on both sides. Guarding against
// feedback loops follows the pattern already used by `DirectoryPanel`: remember which
// pane the user last touched, and flag programmatic scrolling so its own scroll event
// is ignored.

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { MarkdownView } from './AssistantMarkdown';
import { TranslateHtml } from './TranslateHtml';
import { createTextareaMirror, type TextareaMirror } from './textareaMetrics';
import { selectionToBlocks, type Block, type BlockAlignment, type SourceFormat } from './translateFormat';

export type PaneSide = 'source' | 'target';
export type BlockRange = [number, number];

type PaneProps = {
  side: PaneSide;
  title: string;
  subtitle?: string;
  text: string;
  format: SourceFormat;
  blocks: Block[];
  scrollRef: RefObject<HTMLElement | null>;
  docRef?: RefObject<HTMLDivElement | null>;
  sourceMirror?: RefObject<TextareaMirror | null>;
  focusedRange: BlockRange | null;
  editable?: boolean;
  preview?: boolean;
  onPreviewChange?: (preview: boolean) => void;
  onTextChange?: (value: string) => void;
  onInteract: () => void;
  onScroll: () => void;
  onSelection: (range: BlockRange | null) => void;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  placeholder?: string;
  id?: string;
  label?: string;
};

function renderBlock(text: string, format: SourceFormat) {
  if (format === 'html') return <TranslateHtml text={text}/>;
  if (format === 'markdown') return <MarkdownView text={text}/>;
  return <div className="translate-plain">{text}</div>;
}

export function TranslatePane({
  side, title, subtitle, text, format, blocks, scrollRef, docRef, sourceMirror, focusedRange,
  editable, preview, onPreviewChange, onTextChange, onInteract, onScroll, onSelection,
  headerExtra, footer, placeholder, id, label,
}: PaneProps) {
  const editing = Boolean(editable && !preview);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const localMirror = useRef<TextareaMirror | null>(null);
  const mirrorRef = sourceMirror ?? localMirror;
  const currentText = useRef(text);
  currentText.current = text;

  // A textarea hides its internal line boxes, so a styled mirror supplies the geometry
  // that scroll anchoring needs while the user is still editing.
  useLayoutEffect(() => {
    if (!editing) { mirrorRef.current?.dispose(); mirrorRef.current = null; return; }
    const field = textareaRef.current;
    if (!field) return;
    const mirror = createTextareaMirror(field);
    mirror.refresh(currentText.current);
    mirrorRef.current = mirror;
    const observer = new ResizeObserver(() => mirror.refresh(currentText.current));
    observer.observe(field);
    return () => { observer.disconnect(); mirror.dispose(); if (mirrorRef.current === mirror) mirrorRef.current = null; };
  }, [editing, mirrorRef]);

  useLayoutEffect(() => { if (editing) mirrorRef.current?.refresh(text); }, [editing, text, mirrorRef]);

  // Read the current selection whether the pane is being edited or only previewed.
  const reportSelection = useCallback(() => {
    if (!blocks.length) return;
    if (editing) {
      const field = textareaRef.current;
      if (!field) return;
      onSelection(selectionToBlocks(blocks, field.selectionStart, field.selectionEnd));
      return;
    }
    const root = docRef?.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) { onSelection(null); return; }
    const range = selection.getRangeAt(0);
    // A selectionchange also fires for the other pane. Only a selection that really is
    // inside this pane may claim the shared highlight, otherwise the two clear each other.
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    if (selection.isCollapsed) { onSelection(null); return; }
    // 可见文字不含标签与 Markdown 标记，不能按原文字符偏移定位。
    const selected = [...root.querySelectorAll<HTMLElement>('[data-block]')].filter(block => {
      // intersectsNode 会把“在下一段第一个字符之前结束”也算作碰到该段。
      // 只计算实际选中的非空文字，避免端点与相邻段落产生错误匹配。
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const content = document.createRange();
        content.selectNodeContents(node);
        if (range.compareBoundaryPoints(Range.END_TO_START, content) < 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, content) > 0) return true;
      }
      return false;
    });
    onSelection(selected.length ? [Number(selected[0].dataset.block), Number(selected[selected.length - 1].dataset.block)] : null);
  }, [blocks, editing, docRef, onSelection]);

  // The preview view has no native selection event, so watch the document instead.
  useEffect(() => {
    if (editing) return;
    const handler = () => reportSelection();
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [editing, reportSelection]);

  // In edit mode the textarea is the scroller, and scroll events do not bubble, so the
  // same handlers have to sit on both elements.
  const interaction = {onScroll, onWheel:onInteract, onPointerDown:onInteract, onKeyDown:onInteract,
    onMouseUp:reportSelection, onKeyUp:reportSelection};

  // The pane is the scroll container itself: the wrapper in preview mode, the textarea
  // while editing. `scrollRef` must follow whichever one is live.
  const attachScroll = useCallback((node: HTMLElement | null) => {
    textareaRef.current = (node as HTMLTextAreaElement) ?? null;
    scrollRef.current = node;
  }, [scrollRef]);

  return <section className={`translate-pane ${side}`} aria-label={title}>
    <header>
      <div className="translate-pane-title"><h2>{title}</h2>{subtitle&&<span>{subtitle}</span>}</div>
      <div className="translate-pane-tools">
        {headerExtra}
        {onPreviewChange&&<button type="button" className={`translate-toggle ${preview?'on':''}`} aria-pressed={preview}
          onClick={()=>{onPreviewChange(!preview);requestAnimationFrame(reportSelection);}}>{preview?'编辑原文':'预览格式'}</button>}
      </div>
    </header>
    <div className={`translate-body ${editing?'editing':'previewing'}`} ref={editing?undefined:attachScroll} {...interaction}>
      {editing
        ? <textarea id={id} aria-label={label} ref={attachScroll} value={text} placeholder={placeholder} spellCheck={false}
            onChange={event=>onTextChange?.(event.target.value)} onSelect={reportSelection} {...interaction}/>
        : <div className="translate-doc" ref={docRef}>
            {blocks.length
              ? blocks.map(block=><div key={block.index} data-block={block.index}
                  className={`translate-block ${block.kind}${focusedRange&&block.index>=focusedRange[0]&&block.index<=focusedRange[1]?' sync-focus':''}`}>
                  {renderBlock(text.slice(block.start, block.end), format)}
                </div>)
              : <div className="translate-placeholder">{placeholder}</div>}
          </div>}
    </div>
    {footer&&<footer>{footer}</footer>}
  </section>;
}

export type SyncController = {
  sourceScroll: RefObject<HTMLElement | null>;
  targetScroll: RefObject<HTMLElement | null>;
  sourceDoc: RefObject<HTMLDivElement | null>;
  targetDoc: RefObject<HTMLDivElement | null>;
  sourceMirror: RefObject<TextareaMirror | null>;
  markActive: (side: PaneSide) => void;
  handleScroll: (side: PaneSide) => void;
};

/**
 * Keeps the two panes aligned. Scroll anchoring uses the topmost visible block on the
 * pane the user is driving and scrolls the other pane to the matching block; the
 * direction is chosen by whichever pane was touched last so the two never fight.
 *
 * 编辑模式通过共享测量镜像取得段落位置；预览模式直接测量段落元素。
 * 两种模式都按已确认的对应段落和段内进度定位，支持双向联动。
 */
export function useTranslationSync({enabled, sourceBlocks, targetBlocks, alignment, resetKey}:{
  enabled:boolean; sourceBlocks:Block[]; targetBlocks:Block[]; alignment:BlockAlignment; resetKey:unknown;
}) {
  const sourceScroll = useRef<HTMLElement | null>(null);
  const targetScroll = useRef<HTMLElement | null>(null);
  const sourceDoc = useRef<HTMLDivElement | null>(null);
  const targetDoc = useRef<HTMLDivElement | null>(null);
  const sourceMirror = useRef<TextareaMirror | null>(null);
  const active = useRef<PaneSide | null>(null);
  const syncing = useRef(false);
  const frame = useRef(0);

  // New task or cleared text: forget which pane was driving so the next gesture wins.
  useEffect(() => {
    active.current = null;
    syncing.current = false;
    cancelAnimationFrame(frame.current);
  }, [resetKey]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const markActive = useCallback((side: PaneSide) => { active.current = side; }, []);

  const handleScroll = useCallback((side: PaneSide) => {
    if (!enabled || !alignment.reliable || syncing.current) return;
    // The first pane to scroll becomes the driver; after that only the pane the user
    // last touched steers, so the two never fight each other.
    if (active.current !== null && active.current !== side) return;
    active.current = side;

    const from = side === 'source' ? sourceScroll.current : targetScroll.current;
    const to = side === 'source' ? targetScroll.current : sourceScroll.current;
    if (!from || !to) return;
    const fromModel = side === 'source' ? sourceBlocks : targetBlocks;
    const toModel = side === 'source' ? targetBlocks : sourceBlocks;
    const map = side === 'source' ? alignment.forward : alignment.backward;

    const bounds = (scroller: HTMLElement, model: Block[], index: number) => {
      const block = model[index];
      if (!block) return null;
      if (scroller instanceof HTMLTextAreaElement) {
        const mirror = sourceMirror.current;
        if (!mirror) return null;
        return { top: mirror.topAt(block.start), bottom: mirror.topAt(model[index + 1]?.start ?? block.end) };
      }
      const element = scroller.querySelector<HTMLElement>(`[data-block="${block.index}"]`);
      if (!element) return null;
      const origin = scroller.getBoundingClientRect().top;
      const rect = element.getBoundingClientRect();
      const next = model[index + 1] && scroller.querySelector<HTMLElement>(`[data-block="${model[index + 1].index}"]`);
      return { top: rect.top - origin + scroller.scrollTop,
        bottom: (next ? next.getBoundingClientRect().top : rect.bottom) - origin + scroller.scrollTop };
    };

    let anchor = 0;
    if (from instanceof HTMLTextAreaElement) {
      const offset = sourceMirror.current?.anchorAt(from.scrollTop).offset;
      if (offset === undefined) return;
      anchor = selectionToBlocks(fromModel, offset, offset + 1)?.[0] ?? 0;
    } else {
      while (anchor < fromModel.length - 1 && (bounds(from, fromModel, anchor)?.bottom ?? Infinity) <= from.scrollTop) anchor++;
    }
    const target = map[anchor];
    if (target === undefined || target < 0) return;
    const fromBounds = bounds(from, fromModel, anchor);
    const toBounds = bounds(to, toModel, target);
    if (!fromBounds || !toBounds) return;
    const progress = Math.max(0, Math.min(1, (from.scrollTop - fromBounds.top) / Math.max(1, fromBounds.bottom - fromBounds.top)));
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = Math.max(0, to.scrollHeight - to.clientHeight);
    const position = from.scrollTop <= 1 ? 0 : fromMax > 0 && from.scrollTop >= fromMax - 1 ? toMax
      : toBounds.top + progress * (toBounds.bottom - toBounds.top);
    syncing.current = true;
    to.scrollTop = Math.max(0, Math.min(toMax, position));
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { syncing.current = false; });
  }, [enabled, alignment, sourceBlocks, targetBlocks]);

  return { sourceScroll, targetScroll, sourceDoc, targetDoc, sourceMirror, markActive, handleScroll };
}
