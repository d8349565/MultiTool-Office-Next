import { Button } from '@fluentui/react-components';
import { Modal } from './components';
import { basename } from './domain';
import type { OcrRenameBatch } from './ocrTypes';

const names:Record<string,string>={pending:'可执行',done:'已改名',undone:'已撤销',failed:'失败',blocked:'已排除',conflict:'冲突',applying:'操作中',undoing:'撤销中'};
export function renameMessage(batch:OcrRenameBatch,undo:boolean){
  const success=batch.items.filter(i=>i.status===(undo?'undone':'done')).length;
  const failed=batch.items.filter(i=>undo?i.status==='done'&&!!i.error:i.status==='failed').length;
  const pending=batch.items.filter(i=>undo?i.status==='done'&&!i.error:['pending','applying'].includes(i.status)).length;
  const blocked=batch.items.length-success-failed-pending;
  const action=undo?'撤销':'改名';
  return `${action}结果：成功 ${success} 项，失败 ${failed} 项，未处理 ${pending} 项，排除 ${blocked} 项。`;
}
export function OcrRenameDialog({batch,undo,busy,error,onClose,onApply,onRecheck,onExport}:{batch:OcrRenameBatch;undo:boolean;busy:boolean;error:string;onClose:()=>void;onApply:()=>void;onRecheck:(ids:string[])=>void;onExport:()=>void}){
  const preview=batch.status==='preview';
  const actionable=batch.items.filter(i=>i.status===(undo?'done':'pending')).length;
  const errors=batch.items.filter(i=>!!i.error);
  const retry=batch.items.filter(i=>['failed','blocked','conflict','pending'].includes(i.status)).map(i=>i.fileId);
  return <Modal title={undo?'撤销批次改名':preview?'检查并确认批量改名':'批次改名结果'} wide className="ocr-rename-dialog" onClose={()=>{if(!busy)onClose();}}>
    <p role="status">{preview?`可改名 ${actionable} 项，异常 ${batch.items.length-actionable} 项。异常项将排除，不覆盖已有文件。`:renameMessage(batch,undo)}</p>
    {!!errors.length&&<p className="muted">请根据逐项原因处理。文件已修改或原名称已被占用时不会强制操作；撤销失败项仍保留恢复记录。</p>}
    <div className="ocr-rename-list">{batch.items.map((item,i)=><div key={i}><span>{basename(undo?item.target:item.original)} → <strong>{basename(undo?item.original:item.target)}</strong></span><small>{names[item.status]||item.status}{item.error?` · ${item.error}`:''}{item.warning?` · ${item.warning}`:''}</small></div>)}</div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <footer className="dialog-actions"><Button type="button" disabled={busy} onClick={onClose}>关闭</Button>{!!errors.length&&<Button type="button" disabled={busy} onClick={onExport}>导出异常项 CSV</Button>}{!preview&&!!retry.length&&<Button type="button" disabled={busy} onClick={()=>onRecheck(retry)}>重新检查未改名项</Button>}{!!actionable&&(undo||preview)&&<Button type="button" appearance="primary" disabled={busy} onClick={onApply}>{undo?(batch.items.some(i=>i.status==='done'&&!!i.error)?'重试未撤销项':'确认撤销'):`${batch.items.length>actionable?'排除异常并执行':'执行改名'} · ${actionable} 项`}</Button>}</footer>
  </Modal>;
}
