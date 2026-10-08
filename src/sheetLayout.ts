// 把后端的“文字矩阵 + 样式表”换算成可直接渲染的表格布局（合并单元格、溢出文字、边框归并）。
// 纯函数、无 React 依赖；后端数据一律当作不可信输入，颜色/线型/数值都在这里再校验一遍。

export type SheetBorder = [number, string, string]; // 线宽 px、线型、颜色
export interface SheetStyle {
  b?: 1; i?: 1; u?: 1; s?: 1; w?: 1;
  c?: string; bg?: string; sz?: number; ind?: number; h?: string; v?: string;
  bl?: SheetBorder; br?: SheetBorder; bt?: SheetBorder; bb?: SheetBorder;
}
export interface SheetGrid {
  styles: SheetStyle[];
  cells: number[][];
  cols: number[];
  rowHeights: number[];
  rowHeight: number;
  merges: number[][];
  gridlines: boolean;
  baseSize: number;
}
export interface SheetCell { col: number; text: string; colSpan: number; rowSpan: number; css: Record<string, string | number> }
export interface SheetRow { height: number; hidden: boolean; cells: SheetCell[] }
export interface SheetLayout { rows: SheetRow[]; cols: number[]; width: number; fontSize: number }

/** 预览面板很小，整体按 80% 显示；字号、列宽、行高同比缩放，版面比例不变。 */
export const SHEET_SCALE = 0.8;
const COLOR = /^#[0-9a-f]{6}$/i;
const LINES = new Set(['solid', 'dashed', 'dotted', 'double']);
const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const VERTICAL = new Set(['top', 'middle']);
const NUMERIC_TEXT = /^[\s\-+(¥$€£]*[\d,.]+%?\)?$/;

const color = (value: unknown) => typeof value === 'string' && COLOR.test(value) ? value : undefined;
const px = (points: number) => points * 4 / 3;
const scaled = (value: number) => Math.round(value * SHEET_SCALE * 10) / 10;

function border(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const [width, kind, tint] = value;
  if (typeof width !== 'number' || !LINES.has(kind) || !color(tint)) return undefined;
  return `${Math.min(3, Math.max(1, Math.round(width)))}px ${kind} ${tint}`;
}

function textWidth(text: string, fontPx: number, bold: boolean) {
  let width = 0;
  for (const character of text) width += character.codePointAt(0)! >= 0x2e80 ? fontPx : /[A-Z0-9]/.test(character) ? fontPx * 0.62 : fontPx * 0.52;
  return width * (bold ? 1.06 : 1) + 8;
}

export function columnName(index: number) {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

export function sheetLayout(text: string[][], grid: SheetGrid): SheetLayout {
  const rowCount = text.length, colCount = grid.cols.length;
  const widths = grid.cols.map(value => Math.max(0, Math.min(600, Number(value) || 0)));
  const key = (row: number, col: number) => row * colCount + col;
  const style = (row: number, col: number): SheetStyle => grid.styles[grid.cells[row]?.[col] ?? 0] ?? {};
  const covered = new Set<number>(), origins = new Map<number, [number, number]>();

  for (const merge of grid.merges) {
    const [top, left, bottom, right] = merge;
    if (![top, left, bottom, right].every(Number.isInteger) || top < 0 || left < 0 || bottom >= rowCount || right >= colCount || bottom < top || right < left) continue;
    const cells = [];
    for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) cells.push(key(row, col));
    if (cells.some(cell => covered.has(cell) || origins.has(cell))) continue; // 重叠的合并区域以先出现者为准
    origins.set(key(top, left), [bottom - top + 1, right - left + 1]);
    cells.slice(1).forEach(cell => covered.add(cell));
  }

  const rows: SheetRow[] = [];
  for (let row = 0; row < rowCount; row++) {
    const cells: SheetCell[] = [];
    const declared = grid.rowHeights[row] ?? 0;
    for (let col = 0; col < colCount; col++) {
      if (covered.has(key(row, col))) continue;
      const own = style(row, col), value = text[row]?.[col] ?? '';
      let [rowSpan, colSpan] = origins.get(key(row, col)) ?? [1, 1];

      // Excel 里不换行的左对齐文字会盖住右侧的空单元格；这里把这些空格并入当前单元格。
      const spills = widths[col] > 0 && !origins.has(key(row, col)) && value && !own.w && (own.h === undefined || own.h === 'left') && !NUMERIC_TEXT.test(value);
      if (spills) {
        const needed = textWidth(value, px(own.sz ?? grid.baseSize), !!own.b);
        let available = widths[col];
        while (available < needed && col + colSpan < colCount) {
          const next = col + colSpan, neighbour = style(row, next);
          if (covered.has(key(row, next)) || origins.has(key(row, next)) || text[row]?.[next] || (neighbour.bg ?? own.bg) !== own.bg) break;
          covered.add(key(row, next));
          available += widths[next];
          colSpan++;
        }
      }

      const css: Record<string, string | number> = {};
      const background = color(own.bg), foreground = color(own.c);
      if (background) {
        css.backgroundColor = background;
        if (!foreground) {
          const r = parseInt(background.slice(1, 3), 16);
          const g = parseInt(background.slice(3, 5), 16);
          const b = parseInt(background.slice(5, 7), 16);
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          css.color = lum > 0.5 ? '#1f1f1f' : '#ffffff';
        }
      }
      if (foreground) css.color = foreground;
      if (own.b) css.fontWeight = 700;
      if (own.i) css.fontStyle = 'italic';
      const decoration = [own.u && 'underline', own.s && 'line-through'].filter(Boolean).join(' ');
      if (decoration) css.textDecoration = decoration;
      if (typeof own.sz === 'number' && own.sz > 0) css.fontSize = `${Math.max(7, scaled(px(Math.min(72, own.sz))))}px`;
      if (own.h && ALIGN.has(own.h)) css.textAlign = own.h;
      if (own.v && VERTICAL.has(own.v)) css.verticalAlign = own.v;
      if (own.w) { css.whiteSpace = 'pre-wrap'; css.overflowWrap = 'anywhere'; }
      if (own.ind && (own.h === undefined || own.h === 'left')) css.paddingLeft = `${scaled(4 + Math.min(15, own.ind) * 9)}px`;

      // 每格只画右/下边；相邻格各自声明的同一条边，取先声明者，避免重复和缺失。
      const lastCol = col + colSpan - 1, lastRow = row + rowSpan - 1;
      const right = border(style(row, lastCol).br) ?? (lastCol + 1 < colCount ? border(style(row, lastCol + 1).bl) : undefined);
      const bottom = border(style(lastRow, col).bb) ?? (lastRow + 1 < rowCount ? border(style(lastRow + 1, col).bt) : undefined);
      const left = col === 0 ? border(own.bl) : undefined, top = row === 0 ? border(own.bt) : undefined;
      if (right) css.borderRight = right;
      if (bottom) css.borderBottom = bottom;
      if (left) css.borderLeft = left;
      if (top) css.borderTop = top;

      cells.push({ col, text: value, colSpan, rowSpan, css });
    }
    const hidden = declared < 0;
    rows.push({ hidden, height: scaled(Math.min(800, declared > 0 ? declared : Number(grid.rowHeight) > 0 ? grid.rowHeight : 20)), cells });
  }
  const cols = widths.map(scaled);
  return { rows, cols, width: cols.reduce((sum, value) => sum + value, 0), fontSize: Math.max(8, scaled(px(Number(grid.baseSize) > 0 ? grid.baseSize : 11))) };
}
