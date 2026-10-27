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
  const [record,setRecord]=useState<RenameRecord|null>(null),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),operation=useRef(false);
  const finalName=name+(editExtension?'':suffix),parent=dirname(entry.path),target=`${parent}/${finalName}`;
  const completed=record?.status==='done'||record?.status==='undone';
  useEffect(()=>{input.current?.focus();input.current?.select();},[]);
  const change=()=>{setRecord(null);setAck(false);setError('');};
  async function submit(action:'preview'|'apply'|'undo') {
    if(operation.current)return;operation.current=true;setBusy(true);setError('');
    try {
      const next=await api<RenameRecord>(action==='preview'?'workspace_rename_preview':'workspace_rename_apply',action==='preview'?{path:entry.path,newName:finalName,isDir:entry.isDir,allowExtensionChange:editExtension}:{id:record!.id,action});
      setRecord(next);
      if(action!=='preview'){
        if(next.status===(action==='undo'?'undone':'done'))onChanged(next);
        else{setError(next.error||'操作未完成，请重新核对。');if(action==='apply')setRecord(null);}
      }
    }catch(e){setError(String(e));if(action==='apply')setRecord(null);}
    finally{operation.current=false;setBusy(false);}
  }
  return <Modal title={`重命名${entry.isDir?'文件夹':'文件'}`} onClose={()=>{if(!operation.current)onClose();}} className="workspace-rename">
    <form onSubmit={event=>{event.preventDefault();if(!completed&&(!record?.extensionChanged||ack))void submit(record?'apply':'preview');}} aria-busy={busy}>
      <p className="rename-help">{completed?(record.status==='undone'?'已恢复原名称。':'已完成改名。撤销前会再次核对对象状态和原名占用。'):'只更改当前目录中的名称。先核对路径，再确认执行；取消或 Esc 不改动文件。'}</p>
      {!completed&&<>
        <label className="rename-input-label" htmlFor="workspace-rename-name">新名称</label>
        <div className="rename-input"><input ref={input} id="workspace-rename-name" value={name} disabled={busy} autoComplete="off" spellCheck={false} onChange={event=>{setName(event.target.value);change();}} aria-describedby="workspace-rename-detail"/>{!editExtension&&suffix&&<span>{suffix}</span>}</div>
        <p id="workspace-rename-detail" className="rename-help">原名称：{entry.name}<br/>所在目录：{parent}</p>
        {!entry.isDir&&<Checkbox checked={editExtension} disabled={busy} label="同时修改扩展名（可能影响文件打开方式）" onChange={(_,data)=>{const next=!!data.checked;setName(next?finalName:suffix&&name.endsWith(suffix)?name.slice(0,-suffix.length):name);setEditExtension(next);change();}}/>}
      </>}
      <Paths record={record||{original:entry.path,target}}/>
      {record?.status==='preview'&&<p className="rename-help" role="status">已完成安全预检，尚未改名。确认时仍会复核；预览 10 分钟后失效。</p>}
      {record?.extensionChanged&&!completed&&<Checkbox checked={ack} disabled={busy} label="我已核对完整名称，并确认修改扩展名" onChange={(_,data)=>setAck(!!data.checked)}/>}
      {record?.status==='done'&&<p className="rename-help">撤销将恢复为：{basename(record.original)}</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      {record?.warning&&<p className="inline-error" role="status">{record.warning}</p>}
      <p className="rename-help">只核对本地文件标识、大小和 Windows 变更时间，不读取文档正文。大小写单独调整、超过 240 字符的完整路径、链接和受保护对象暂不支持；目录最多核对 10,000 个子项。</p>
      <footer className="dialog-actions"><span role="status">{busy?'正在核对并处理，请稍候…':''}</span><Button type="button" disabled={busy} onClick={onClose}>{completed?'关闭':'取消'}</Button>
        {record?.status==='done'?<Button type="button" disabled={busy||!record.fingerprint} onClick={()=>void submit('undo')}>撤销这次改名</Button>:!completed&&<Button type="submit" appearance="primary" disabled={busy||!name||finalName===entry.name||!!record?.extensionChanged&&!ack}>{record?'确认改名':'预览变更'}</Button>}
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
