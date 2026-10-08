import { useMemo, type CSSProperties } from 'react';
import { columnName, sheetLayout, type SheetGrid } from './sheetLayout';

const HEADER_WIDTH = 36;

/** 按 Excel 原有的列宽、行高、字体、颜色、边框、合并单元格还原表格。 */
export function SheetPreview({ rows, grid }: { rows: string[][]; grid: SheetGrid }) {
  const layout = useMemo(() => sheetLayout(rows, grid), [rows, grid]);
  return <table className={`sheet-grid${grid.gridlines ? '' : ' no-lines'}`} style={{ width: layout.width + HEADER_WIDTH, fontSize: layout.fontSize }}>
    <colgroup><col style={{ width: HEADER_WIDTH }} />{layout.cols.map((width, index) => <col key={index} style={width ? { width } : { width: 0, visibility: 'collapse' }} />)}</colgroup>
    <thead><tr><th aria-label="行号">#</th>{layout.cols.map((_, index) => <th key={index} scope="col">{columnName(index)}</th>)}</tr></thead>
    <tbody>{layout.rows.map((row, index) => <tr key={index} style={row.hidden ? { visibility: 'collapse' } : { height: row.height }}>
      <th scope="row">{index + 1}</th>
      {row.cells.map(cell => <td key={cell.col} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined} rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined} style={cell.css as CSSProperties}>{cell.text}</td>)}
    </tr>)}</tbody>
  </table>;
}
