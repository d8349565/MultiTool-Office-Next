import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Settings, Entry, Query, Results } from './types';
import { basename, cleanPath, isWithin } from './domain';
import { detectFormat } from './translateFormat';
import { localDate } from './todoSchedule';
import { previewDemo } from './filePreviewModel';
export const desktop = isTauri();
export const demo = !desktop && new URLSearchParams(location.search).has('demo');
// 浏览器演示使用合成名称与路径，不代表实际客户或内部系统。
const demoRoot = 'D:/演示工作区';
const initialDemoLaunchers = [
  { id: '1', name: '数据清洗与汇总脚本', path: 'D:/演示工作区/工具脚本/data_cleaner.py', group: '数据处理' },
  { id: '2', name: '文档批量识别', path: 'D:/演示工作区/工具脚本/ocr_batch.pyw', group: '数据处理' },
  { id: '3', name: '项目数据汇总表', path: 'D:/演示工作区/归档文件/数据汇总表.xlsx', group: '日常办公' },
  { id: '4', name: '通用文档模板', path: 'D:/演示工作区/文档资料/文档模板.docx', group: '日常办公' },
  { id: '5', name: '演示项目甲图片说明', path: 'D:/演示工作区/项目文件/演示项目甲/第一阶段/图片素材/图片说明.pdf', group: '设计资产' },
  { id: '6', name: 'VS Code 代码编辑器', path: 'C:/Program Files/Microsoft VS Code/Code.exe', group: '开发环境' },
  { id: '7', name: '本地工作区备份脚本', path: 'D:/演示工作区/工具脚本/backup.bat', group: '系统运维' },
  { id: '8', name: '团队协作门户系统', path: 'https://example.com', group: '在线入口' },
  { id: '9', name: '设计资产共享目录', path: 'D:/演示工作区/图片资源/', group: '常用目录' },
];
let settings: Settings = { schemaVersion: 1, revision: 0, roots: [demoRoot], theme: 'light', recursive: true, filter: '', launchers: initialDemoLaunchers, modelUrl: '', modelId: '', jevEnabled: false };
const folders = ['项目文件','共享文件','参考资料','图片资源','归档文件','个人文件','项目文件/演示项目甲','项目文件/演示项目乙','项目文件/演示项目丙','项目文件/演示项目丁','项目文件/演示项目甲/第一阶段','项目文件/演示项目甲/第二阶段','项目文件/演示项目甲/阶段记录','项目文件/演示项目甲/第一阶段/文档资料','项目文件/演示项目甲/第一阶段/图片素材','项目文件/演示项目甲/第一阶段/交付文件','项目文件/演示项目甲/第一阶段/文档资料/历史版本','项目文件/演示项目甲/第一阶段/文档资料/历史版本/2026'];
const filePaths = ['项目文件/演示项目甲/第一阶段/项目说明.docx','项目文件/演示项目甲/第一阶段/项目进度.xlsx','项目文件/演示项目甲/第一阶段/会议纪要.md','项目文件/演示项目甲/第一阶段/图片素材/图片说明.pdf','项目文件/演示项目甲/第一阶段/文档资料/合作协议.docx','项目文件/演示项目甲/第一阶段/文档资料/历史版本/2026/合作协议.pdf','项目文件/演示项目甲/第二阶段/网站需求.docx','共享文件/工作安排.xlsx','个人文件/阅读笔记.md'];
const entry = (p: string, isDir: boolean, i: number): Entry => ({ path: `${demoRoot}/${p}`, name: basename(p), parent: `${demoRoot}/${p.split('/').slice(0,-1).join('/')}`.replace(/\/$/,''), extension: isDir ? '' : p.split('.').at(-1)!, size: (i + 1) * 28149, modified: 1789862400 + i * 4800, isDir });
const dirs = folders.map((p,i) => entry(p,true,i)); const files = filePaths.map((p,i) => entry(p,false,i));
const status = { scanning: false, count: files.length, scanned: files.length, errors: [], generation: 1 };
export async function api<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (desktop) return invoke<T>(command, args);
  if (!demo) throw new Error('请通过桌面应用使用本地文件功能。开发预览可使用 ?demo=1。');
  await new Promise(r => setTimeout(r, 35));
  if (command.startsWith('ocr_')) return (await import('./ocrDemo')).ocrDemo(command,args) as Promise<T>;
  switch (command) {
    case 'file_preview': return previewDemo(String(args.path),Number(args.page)||1,Number(args.sheet)||0) as T;
    case 'cancel_file_preview': return undefined as T;
    case 'bootstrap': return { settings, status, keys: { model:false, jev:false } } as T;
    case 'assistant_workspace': return {path:args.path||'演示数据/报告工作区'} as T;
    case 'index_status': return status as T;
    case 'list_dirs': return dirs.filter(d => cleanPath(d.parent) === cleanPath(String(args.path))) as T;
    case 'search': {
      const q = args.query as Query, tokens=(q.query||'').toLowerCase().split(/\s+/).filter(Boolean);
      const pool = q.kind === 'directory' ? dirs : files;
      const filtered=pool.filter(f => (!q.root || (q.recursive ? isWithin(f.path,q.root) : cleanPath(f.parent)===cleanPath(q.root))) && tokens.every(t=>f.path.toLowerCase().includes(t)) && f.path.toLowerCase().includes((q.filter||'').toLowerCase()) && (!q.extension||f.extension===q.extension) && (!q.after||f.modified>=q.after) && (!q.before||f.modified<=q.before));
      return {items:filtered.slice(q.offset||0,(q.offset||0)+(q.limit||100)), total:filtered.length} as Results as T;
    }
    case 'save_settings': settings={...args.next as Settings, revision:settings.revision+1}; return settings as T;
    // 演示用的结构保留翻译：标记、标签与代码围栏原样保留，只给可见文字加前缀。
    case 'ai_task': {
      if(String(args.kind)!=='translate')throw new Error('这是交互演示数据。请在桌面版使用系统操作、模型连接和导入功能。');
      const text=String(args.text||'');
      if(!text.trim())throw new Error('请输入文本，最多 60,000 字节');
      const format=detectFormat(text);
      await new Promise(r=>setTimeout(r,120));
      return {text:format==='html'?demoTranslateHtml(text):demoTranslateMarkdown(text),model:'demo',format,usage:{}} as T;
    }
    case 'reindex': return undefined as T;
    case 'launch':
    case 'reveal_launcher':
    case 'open_path': return undefined as T;
    case 'get_todos': {
      try {
        const raw = localStorage.getItem('office-demo-todos');
        if (raw) return JSON.parse(raw) as T;
      } catch {}
      const initialTodos = [
        { id: '1', title: '交付演示项目甲季度终版交付文档', type: 'todo', quadrant: 1, completed: false, createdAt: Date.now() - 3600000, dueDate: localDate(Date.now()), dueTime: '17:00', subtasks: ['整理财务结算单','生成最终交付PDF','客户邮件确认'] },
        { id: '2', title: '跟进财务核对本季度发票归档清单', type: 'todo', quadrant: 1, completed: false, createdAt: Date.now() - 7200000, dueDate: localDate(Date.now(), -1) },
        { id: '3', title: '深入规划团队下季度知识库与工作流架构', type: 'todo', quadrant: 2, completed: false, createdAt: Date.now() - 86400000, dueDate: localDate(Date.now(), 3) },
        { id: '4', title: '提炼通用 Prompt 规范与评测用例集', type: 'todo', quadrant: 2, completed: false, createdAt: Date.now() - 54000000 },
        { id: '5', title: '回复供应商关于合同附件格式的确认邮件', type: 'todo', quadrant: 3, completed: false, createdAt: Date.now() - 1800000, dueDate: localDate(Date.now(), 1), dueTime: '10:00' },
        { id: '6', title: '清理工作区历史遗留临时日志与缓存', type: 'todo', quadrant: 4, completed: true, createdAt: Date.now() - 100000000 },
        { id: '7', title: '闪念：右键菜单增加一键快速 OCR 取词功能', type: 'idea', quadrant: 0, completed: false, createdAt: Date.now() - 900000 },
        { id: '8', title: '灵感：待办任务支持关联本地文件或工作目录', type: 'idea', quadrant: 0, completed: false, createdAt: Date.now() - 400000 }
      ];
      localStorage.setItem('office-demo-todos', JSON.stringify(initialTodos));
      return initialTodos as T;
    }
    case 'save_todos': {
      localStorage.setItem('office-demo-todos', JSON.stringify(args.todos));
      return undefined as T;
    }
    case 'todo_ai_assist': {
      const action = String(args.action || '');
      const text = String(args.text || '');
      if (action === 'triage') {
        let q: 0 | 1 | 2 | 3 | 4 = 2;
        let reason = '属于高价值长期战略性事项，建议排期聚焦：第 Ⅱ 象限 (重要不紧急)';
        if (/今天|马上|紧急|发票|审批|截止|尽快|交付|催/i.test(text)) {
          q = 1;
          reason = '检测到明确时间期限或紧迫交付要求，建议进入：第 Ⅰ 象限 (重要且紧急)';
        } else if (/回复|通知|邮件|问一下|确认|转交/i.test(text)) {
          q = 3;
          reason = '属于协作沟通与流转事务，建议快速处理：第 Ⅲ 象限 (紧急不重要)';
        } else if (/灵感|想法|考虑|试试|闪念/i.test(text)) {
          q = 0;
          reason = '属于初步闪念，建议暂存：闪念收集箱';
        }
        return { triage: { quadrant: q, reason } } as T;
      }
      if (action === 'breakdown') {
        return {
          breakdown: [
            '第一步：快速收集与核对基础资料、前置数据 (约15分钟)',
            '第二步：梳理核心提纲与要点，完成第一轮草案 (约30分钟)',
            '第三步：最终检查格式并输出，归档发送 (约15分钟)'
          ]
        } as T;
      }
      if (action === 'expand') {
        return {
          expand: {
            scenario: '在查看长篇文档或表格时，无需频繁切屏即可提取关键数据，极大减少注意力损耗。',
            tech: '复用现存本地 RapidOCR 推理进程，截屏后 0.3 秒内把识别文本塞入剪贴板。',
            firstStep: '在文件列表中先试做一个右键菜单快速操作项，验证手感。'
          }
        } as T;
      }
      if (action === 'focus') {
        return {
          focus: {
            q1Focus: '按实际截止时间，优先处理第Ⅰ象限中的逾期及今天到期事项。',
            q2Focus: '结合已设日期推进第Ⅱ象限事项，未排期的任务先明确安排。',
            q3Batch: '在实际截止时间前集中处理第Ⅲ象限事务，不强制指定时段。',
            advice: '演示模式为通用建议；具体日期、时间和事项以清单为准。'
          }
        } as T;
      }
      return {} as T;
    }
    default: throw new Error('这是交互演示数据。请在桌面版使用系统操作、模型连接和导入功能。');
  }
}
/** 演示翻译：保留 Markdown 结构，只给标题、列表项和正文加“译：”前缀。 */
function demoTranslateMarkdown(text:string){
  let inFence=false;
  return text.split('\n').map(line=>{
    if(/^\s*(```|~~~)/.test(line)){inFence=!inFence;return line;}
    if(inFence||!line.trim())return line;
    if(/^\s*\|/.test(line))return line;
    if(/^#{1,6}\s/.test(line))return line.replace(/^(#{1,6}\s+)/,'$1译：');
    if(/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line))return line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/,'$1译：');
    return `译：${line}`;
  }).join('\n');
}
/** 演示翻译：只给标签之间的可见文字加前缀，标签与属性原样保留。 */
function demoTranslateHtml(text:string){
  return text.replace(/>([^<]+)</g,(match,inner:string)=>{
    const trimmed=inner.trim();
    if(!trimmed)return match;
    const lead=inner.slice(0,inner.length-inner.trimStart().length);
    const tail=inner.slice(inner.trimEnd().length);
    return `>${lead}译：${trimmed}${tail}<`;
  });
}
export async function pick(directory: boolean) {
  if (!desktop) throw new Error('选择本地路径需要运行桌面版');
  const { open }=await import('@tauri-apps/plugin-dialog');
  return open({directory,multiple:false});
}
export async function copy(text:string) { if(desktop){const {writeText}=await import('@tauri-apps/plugin-clipboard-manager');await writeText(text);}else{await navigator.clipboard.writeText(text);} }
