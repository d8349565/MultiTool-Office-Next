import type { SheetGrid } from './sheetLayout';

export interface FilePreviewData {
  kind: 'text' | 'table' | 'image';
  text?: string;
  format?: 'plain' | 'markdown';
  image?: string;
  page?: number;
  pageCount?: number;
  rows?: string[][];
  sheets?: string[];
  sheet?: number;
  grid?: SheetGrid;
  truncated: boolean;
  notice: string;
}

export interface PreviewAnchor { left:number; right:number; top:number; bottom:number }
export function previewPosition(anchor:PreviewAnchor, width:number, height:number) {
  const panelWidth=Math.min(520,width-24),panelHeight=Math.min(420,height-24);
  // 尽量放在文件行旁边；空间不足时靠边，始终保留关闭按钮。
  const left=anchor.right+8+panelWidth<=width-12?anchor.right+8:anchor.left-8-panelWidth>=12?anchor.left-8-panelWidth:width-panelWidth-12;
  const top=Math.max(12,Math.min(anchor.top,height-panelHeight-12));
  return {left,top,width:panelWidth,height:panelHeight};
}

/**
 * 演示预览的页面占位图。
 *
 * 这是一张刻意保持极小的图：它只用于让翻页、缩放等“状态机”用例有可断言的 <img>，
 * 不用于验证真实渲染效果。需要校验实际页面成像的用例请注入具名样本页，
 * 不要用 naturalWidth 之类的属性去推断占位图代表什么。
 */
export const 占位页面图='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';

export function previewDemo(path:string,page:number,sheet:number):FilePreviewData {
  const name=path.split(/[\\/]/).at(-1)||'示例文件',extension=name.split('.').at(-1)?.toLowerCase();
  if(extension==='xlsx'||extension==='csv'||extension==='tsv') {
    const rows = [['事项','负责人','状态','预算'],[sheet?'季度报告':'需求确认','张宁','已完成','¥12,800.00'],['设计评审','李明','进行中','¥8,500.00'],['交付归档','王悦','待处理','¥23,000.00']];
    let grid: SheetGrid | undefined;
    if(extension==='xlsx') {
      grid = {
        styles: [
          {},
          { b: 1, c: '#ffffff', bg: '#4472c4', h: 'center', v: 'middle', sz: 12, bb: [2, 'solid', '#2f5597'] },
          { h: 'left', v: 'middle' },
          { h: 'center', v: 'middle', bg: '#e2efda', c: '#375623' },
          { h: 'center', v: 'middle', bg: '#fff2cc', c: '#7f6000' },
          { h: 'center', v: 'middle', bg: '#f2f2f2', c: '#595959' },
          { h: 'right', v: 'middle' }
        ],
        cells: [
          [1, 1, 1, 1],
          [2, 2, 3, 6],
          [2, 2, 4, 6],
          [2, 2, 5, 6]
        ],
        cols: [120, 80, 80, 110],
        rowHeights: [28, 24, 24, 24],
        rowHeight: 22,
        merges: [],
        gridlines: true,
        baseSize: 11
      };
    }
    return {
      kind:'table',
      rows,
      ...(extension==='xlsx'?{sheets:['项目进度','季度安排'],sheet,grid}:{}),
      truncated:false,
      notice:extension==='xlsx'?'示例表格 · 桌面版按 Excel 原格式与单元格样式读取所选文件。':'示例表格 · 桌面版仅在本机读取所选文件。'
    };
  }
  if(extension==='pdf')return {kind:'image',image:占位页面图,page,pageCount:3,truncated:false,notice:'示例页面 · 桌面版显示文件的实际页面。'};
  return {kind:'text',text:extension==='md'?'# 项目会议纪要\n\n讨论品牌升级方案与交付安排。\n\n- 核对需求范围\n- 确认项目时间\n- 整理交付文件':`${name}\n\n项目背景\n本项目围绕团队协作与资料归档展开。\n\n工作安排\n完成需求确认、方案评审和交付核对。`,format:extension==='md'?'markdown':'plain',truncated:false,notice:'示例正文 · 桌面版仅在本机读取所选文件。'};
}
