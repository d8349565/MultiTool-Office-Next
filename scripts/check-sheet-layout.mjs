import assert from 'node:assert/strict';
import { columnName, sheetLayout, SHEET_SCALE } from '../src/sheetLayout.ts';

// 1. 列名换算
assert.equal(columnName(0), 'A');
assert.equal(columnName(25), 'Z');
assert.equal(columnName(26), 'AA');
assert.equal(columnName(27), 'AB');
assert.equal(columnName(51), 'AZ');
assert.equal(columnName(52), 'BA');

// 2. 表格布局与合并单元格
const grid = {
  styles: [
    {},
    { b: 1, c: '#ffffff', bg: '#4472c4', h: 'center', v: 'middle', sz: 12, bb: [2, 'solid', '#2f5597'] },
    { h: 'left', v: 'middle', bg: '#ffff00' }, // 浅黄背景，未指定 c，应自适应深色文字
    { h: 'right', v: 'middle', br: [1, 'solid', '#000000'] }
  ],
  cells: [
    [1, 1, 0],
    [2, 0, 3],
    [0, 0, 0]
  ],
  cols: [100, 80, 120],
  rowHeights: [30, -1, 20], // 第 2 行隐藏
  rowHeight: 20,
  merges: [[0, 0, 0, 1]], // A1:B1 合并
  gridlines: true,
  baseSize: 11
};

const rows = [
  ['标题', '', '说明'],
  ['浅黄高亮', '测试', '数值'],
  ['', '', '']
];

const layout = sheetLayout(rows, grid);

// 列宽缩放校验
assert.equal(layout.cols.length, 3);
assert.equal(layout.cols[0], Math.round(100 * SHEET_SCALE * 10) / 10);
assert.equal(layout.cols[1], Math.round(80 * SHEET_SCALE * 10) / 10);
assert.equal(layout.cols[2], Math.round(120 * SHEET_SCALE * 10) / 10);

// 合并单元格校验：第 1 行只保留 2 个单元格，A1 的 colSpan 为 2
assert.equal(layout.rows[0].cells.length, 2);
assert.equal(layout.rows[0].cells[0].colSpan, 2);
assert.equal(layout.rows[0].cells[0].rowSpan, 1);
assert.equal(layout.rows[0].cells[0].text, '标题');
assert.equal(layout.rows[0].cells[0].css.fontWeight, 700);
assert.equal(layout.rows[0].cells[0].css.backgroundColor, '#4472c4');
assert.equal(layout.rows[0].cells[0].css.color, '#ffffff');

// 隐藏行校验
assert.equal(layout.rows[1].hidden, true);

// 浅黄背景反色对比度校验：黄色背景且无 c 时，字体应为深色 #1f1f1f
assert.equal(layout.rows[1].cells[0].css.backgroundColor, '#ffff00');
assert.equal(layout.rows[1].cells[0].css.color, '#1f1f1f');

// 边框样式校验
assert.equal(layout.rows[0].cells[0].css.borderBottom, '2px solid #2f5597');

// 隐藏列的文字不能借助空白可见列显示；普通可见列仍允许溢出。
const spillGrid = { ...grid, styles: [{}], cells: [[0, 0, 0]], cols: [0, 180, 100], rowHeights: [20], merges: [] };
const hiddenColumn = sheetLayout([['HIDDEN_TEXT', '', 'visible']], spillGrid);
assert.equal(hiddenColumn.cols[0], 0);
assert.equal(hiddenColumn.rows[0].cells[0].colSpan, 1);
assert.equal(hiddenColumn.rows[0].cells[1].text, '');
const visibleColumn = sheetLayout([['LONG_VISIBLE_TEXT', '', 'visible']], { ...spillGrid, cols: [40, 180, 100] });
assert.equal(visibleColumn.rows[0].cells[0].colSpan, 2);

// 稀疏工作表补齐后的纵横合并区域仍正确覆盖 3 行、4 列。
const sparseMerged = sheetLayout([['标题', '', '', ''], ['', '', '', ''], ['', '', '', '']], {
  ...spillGrid, cells: [[0, 0, 0, 0], [], []], cols: [64, 64, 64, 64], rowHeights: [0, 0, 0], merges: [[0, 0, 2, 3]]
});
assert.equal(sparseMerged.rows[0].cells[0].colSpan, 4);
assert.equal(sparseMerged.rows[0].cells[0].rowSpan, 3);
assert.equal(sparseMerged.rows[1].cells.length, 0);
assert.equal(sparseMerged.rows[2].cells.length, 0);

console.log('SheetLayout 纯函数排版与合并单元格校验通过');
