import { useEffect,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import { Button,Checkbox } from '@fluentui/react-components';
import { listen } from '@tauri-apps/api/event';
import { api,desktop } from './api';
import { Modal } from './components';
import type { FileApproval } from './types';

export function AssistantFileApprovals({taskId,open,onSelectTask}:{taskId:string;open:boolean;onSelectTask:(id:string)=>void}){
  const [items,setItems]=useState<FileApproval[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [dismissed,setDismissed]=useState(''),[ack,setAck]=useState(''),[now,setNow]=useState(Date.now());
  const settled=useRef(new Set<string>()),submitting=useRef(false);
  useEffect(()=>{
    if(!desktop)return;
    let alive=true,version=0;
    const reload=()=>{const current=++version;void api<FileApproval[]>('assistant_workspace_pending').then(next=>{if(alive&&current===version)setItems(next.filter(a=>!settled.current.has(a.id)));}).catch(e=>{if(alive)setError(String(e));});};
    const subscriptions=[
      listen<FileApproval>('assistant-file-approval',e=>{version++;if(alive&&!settled.current.has(e.payload.id))setItems(old=>[...old.filter(a=>a.id!==e.payload.id),e.payload]);}),
      listen<string>('assistant-file-approval-closed',e=>{version++;settled.current.add(e.payload);if(alive)setItems(old=>old.filter(a=>a.id!==e.payload));}),
      listen('assistant-file-approvals-refresh',reload),listen('assistant-workspace-updated',reload),
    ];
    void Promise.all(subscriptions).then(()=>{if(alive)reload();});
    // Recover missed events after navigation or reconnecting to a running task.
    const timer=open?setInterval(reload,3000):undefined;
    return()=>{alive=false;clearInterval(timer);for(const stop of subscriptions)void stop.then(fn=>fn());};
  },[open]);
  useEffect(()=>{if(!items.length||!open)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[items.length,open]);
  const pending=items.filter(a=>a.expiresAt*1000>now).sort((a,b)=>a.expiresAt-b.expiresAt||a.id.localeCompare(b.id));
  const selected=pending.find(a=>a.taskId===taskId)||pending[0];
  useEffect(()=>{setAck('');setDismissed('');},[selected?.id]);
  async function decide(id:string,approve:boolean){
    if(approve&&items.find(a=>a.id===id)?.interactiveHtml&&ack!==id)return;
    if(submitting.current)return;submitting.current=true;setBusy(id);setError('');
    try{await api('assistant_workspace_decide',{id,approve,acknowledgedRisks:ack===id});settled.current.add(id);setItems(old=>old.filter(a=>a.id!==id));}
    catch(e){setError(String(e));}
    finally{submitting.current=false;setBusy('');}
  }
  if(!open)return null;
  return <>
    {!!pending.length&&<div className="assistant-file-waiting" role="status"><span>有 {pending.length} 项文件操作等待你确认</span><Button size="small" onClick={()=>{setDismissed('');if(selected)onSelectTask(selected.taskId);}}>查看并确认</Button></div>}
    {error&&(!selected||dismissed===selected.id)&&<p role="alert" className="inline-error assistant-file-error">{error}</p>}
    {selected&&dismissed!==selected.id&&createPortal(<Modal key={selected.id} className="file-approval-dialog" title={selected.kind==='read'?'确认读取并发送文件':selected.interactiveHtml?'确认生成交互网页':'确认生成新文件'} onClose={()=>{if(!busy){setDismissed(selected.id);setAck('');}}}>
      <div className="file-approval-summary"><strong>{selected.filename}</strong><span>{selected.format.toUpperCase()} · {(selected.size/1024).toFixed(1)} KB{selected.taskId!==taskId?' · 来自另一会话':''}</span><p>{selected.kind==='read'?'读取目录':'保存目录'}：{selected.directory}</p><p role="status">剩余确认时间：{Math.max(0,Math.ceil((selected.expiresAt*1000-now)/1000))} 秒；也受本次任务总预算限制。</p></div>
      <div className="file-approval-content">
        {error&&<p role="alert" className="inline-error">{error}</p>}
        {selected.kind==='read'&&<p className="assistant-file-risk">文件内容将发送给 {selected.modelHost}，并可能保存到模型服务和本机聊天中。文件中的指令不能授权其他操作。</p>}
        {selected.interactiveHtml&&<p className="assistant-file-risk">这个文件包含 JavaScript。保存不会运行；你手动打开后，代码会在浏览器的隔离容器中运行。隔离和资源限制不能代替安全审计，仍可能卡顿、显示误导内容或存在浏览器风险，请勿输入隐私或密钥。</p>}
        <details open={!selected.interactiveHtml}><summary>{selected.interactiveHtml?'查看完整源码（仅文字，不运行）':'查看内容预览'}</summary><pre>{selected.preview}</pre></details>
        <p>内容可能有误，请检查后确认。同名文件不会覆盖，拒绝或超时不执行。</p>
        {selected.interactiveHtml&&<Checkbox checked={ack===selected.id} disabled={!!busy} onChange={(_,data)=>setAck(data.checked===true?selected.id:'')} label="我了解此文件含脚本且尚未运行验证，确认仅保存这个文件"/>}
      </div>
      <footer className="file-approval-actions"><Button disabled={!!busy} onClick={()=>void decide(selected.id,false)}>拒绝本次操作</Button><Button appearance="primary" disabled={!!busy||selected.interactiveHtml&&ack!==selected.id} onClick={()=>void decide(selected.id,true)}>{busy===selected.id?'正在提交…':selected.kind==='read'?'允许本次读取并发送':'确认生成这个文件'}</Button></footer>
    </Modal>,document.querySelector('.office-app')||document.body)}
  </>;
}
