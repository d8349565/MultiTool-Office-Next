import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '@fluentui/react-components';
import { api } from './api';
import { Modal } from './components';
import { basename, dirname } from './domain';
import type { Entry } from './types';
import './workspaceRename.css';

export interface RenameRecord {
  id:string; original:string; target:string; isDir:boolean; created:number;
  status:string; error:string; warning:string; extensionChanged:boolean; fingerprint:string;
}
const labels:Record<string,string>={preview:'待确认',done:'已改名',undone:'已撤销',failed:'未改名',applying:'上次操作待核对',undoing:'上次撤销待核对'};
function Paths({record,undo=false}:{record:Pick<RenameRecord,'original'|'target'>;undo?:boolean}) {
  return <dl className="rename-paths"><dt>{undo?'当前路径':'原路径'}</dt><dd>{undo?record.target:record.original}</dd><dt>{undo?'撤销后路径':'目标路径'}</dt><dd>{undo?record.original:record.target}</dd></dl>;
}

export function WorkspaceRenameDialog({entry,onChanged,onClose}:{entry:Entry;onChanged:(record:RenameRecord)=>void;onClose:()=>void}) {
  const dot=entry.isDir?-1:entry.name.lastIndexOf('.'),suffix=dot>0?entry.name.slice(dot):'';
  const [name,setName]=useState(suffix?entry.name.slice(0,-suffix.length):entry.name),[editExtension,setEditExtension]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),operation=useRef(false);
  const finalName=name+(editExtension?'':suffix),parent=dirname(entry.path),target=`${parent}/${finalName}`;
  useEffect(()=>{input.current?.focus();input.current?.select();},[]);
  async function submit() {
    if(operation.current||!name||finalName===entry.name)return;operation.current=true;setBusy(true);setError('');
    try {
      const plan=await api<RenameRecord>('workspace_rename_preview',{path:entry.path,newName:finalName,isDir:entry.isDir,allowExtensionChange:editExtension});
      const next=await api<RenameRecord>('workspace_rename_apply',{id:plan.id,action:'apply'});
      if(next.status!=='done'){setError(next.error||'改名未完成，请重试。');return;}
      onChanged(next);onClose();
    }catch(e){setError(String(e));}
    finally{operation.current=false;setBusy(false);}
  }
  return <Modal title={`重命名${entry.isDir?'文件夹':'文件'}`} onClose={()=>{if(!operation.current)onClose();}} className="workspace-rename">
    <form onSubmit={event=>{event.preventDefault();void submit();}} aria-busy={busy}>
      <label className="rename-input-label" htmlFor="workspace-rename-name">新名称</label>
      <div className="rename-input"><input ref={input} id="workspace-rename-name" value={name} disabled={busy} autoComplete="off" spellCheck={false} onChange={event=>{setName(event.target.value);setError('');}} aria-describedby="workspace-rename-detail"/>{!editExtension&&suffix&&<span>{suffix}</span>}</div>
      <p id="workspace-rename-detail" className="rename-help">原名称：{entry.name}。改名后可在“改名记录”中撤销。</p>
      {!entry.isDir&&<Checkbox checked={editExtension} disabled={busy} label="同时修改扩展名（可能影响文件打开方式）" onChange={(_,data)=>{const next=!!data.checked;setName(next?finalName:suffix&&name.endsWith(suffix)?name.slice(0,-suffix.length):name);setEditExtension(next);setError('');}}/>}
      <details className="rename-details"><summary>查看完整路径</summary><Paths record={{original:entry.path,target}}/></details>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <footer className="dialog-actions"><span role="status">{busy?'正在检查名称并改名…':''}</span><Button type="button" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" appearance="primary" disabled={busy||!name||finalName===entry.name}>{busy?'正在改名…':'确认改名'}</Button>
      </footer>
    </form>
  </Modal>;
}

export function WorkspaceRenameHistory({onChanged,onClose}:{onChanged:(record:RenameRecord)=>void;onClose:()=>void}) {
  const [records,setRecords]=useState<RenameRecord[]>([]),[confirm,setConfirm]=useState<RenameRecord|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const operation=useRef(false);
  useEffect(()=>{let active=true;void api<RenameRecord[]>('workspace_rename_history').then(items=>{if(active)setRecords(items);}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  async function apply(record:RenameRecord,action:'undo'|'recover') {
    if(operation.current)return;operation.current=true;setBusy(true);setError('');setMessage('');
    try {
      const next=await api<RenameRecord>('workspace_rename_apply',{id:record.id,action});
      setRecords(items=>items.map(item=>item.id===next.id?next:item));
      if(action==='undo'&&next.status!=='undone')setError(next.error||'未能安全撤销，请人工核对。');
      else{if(next.status==='done'||next.status==='undone')onChanged(next);setConfirm(null);setMessage(action==='recover'?'已核对中断状态。':'已撤销改名。');}
      if(next.warning)setMessage(next.warning);
    }catch(e){setError(String(e));}finally{operation.current=false;setBusy(false);}
  }
  return <Modal title="改名记录与撤销" onClose={()=>{if(!operation.current)onClose();}} className="workspace-rename" wide>
    <p className="rename-help">显示最近 50 条执行记录，跨启动保留。撤销只在对象状态未变、原名未被占用时执行；无法确认的中断操作须先核对。</p>
    {confirm?<><Paths record={confirm} undo/><p className="rename-help">确认后将尝试恢复原名称。发生变化或冲突时会停止。</p></>:<div className="rename-history" aria-busy={busy}>{records.map(record=><article key={record.id}><div><strong>{basename(record.original)} → {basename(record.target)}</strong><span>{labels[record.status]||record.status} · {new Date(record.created*1000).toLocaleString('zh-CN')}</span></div><Paths record={record}/>{record.error&&<p className="rename-help">{record.error}</p>}{record.warning&&<p className="inline-error">{record.warning}</p>}{record.status==='done'&&<Button disabled={busy||!record.fingerprint} onClick={()=>{setConfirm(record);setError('');}}>撤销此项…</Button>}{['applying','undoing'].includes(record.status)&&<Button disabled={busy} onClick={()=>void apply(record,'recover')}>核对中断状态</Button>}</article>)}{!busy&&!records.length&&<p className="rename-help">还没有已执行的改名记录。</p>}</div>}
    {busy&&<p role="status" className="rename-help">正在核对并处理，请稍候…</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}{message&&<p className="rename-help" role="status">{message}</p>}
    <footer className="dialog-actions"><Button disabled={busy} onClick={()=>confirm?setConfirm(null):onClose()}>{confirm?'返回记录':'关闭'}</Button>{confirm&&<Button appearance="primary" disabled={busy} onClick={()=>void apply(confirm,'undo')}>确认撤销</Button>}</footer>
  </Modal>;
}
