import { useEffect, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { api } from './api';
type Document={name:string;text:string};
type Documents={directory:string;files:Document[]};
export function AssistantDocuments({onDirtyChange}:{onDirtyChange?:(dirty:boolean)=>void}){
  const [documents,setDocuments]=useState<Documents>(),[name,setName]=useState('SOUL.md'),[text,setText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const original=documents?.files.find(f=>f.name===name)?.text||'';
  const dirty=!!documents&&text!==original;
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  async function load(){setBusy(true);setError('');try{const next=await api<Documents>('assistant_documents');setDocuments(next);setText(next.files.find(f=>f.name===name)?.text||'');setMessage('');}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function save(){setBusy(true);setError('');try{const saved=await api<Document>('save_assistant_document',{name,text,previous:original});setDocuments(d=>d&&({...d,files:d.files.map(f=>f.name===name?saved:f)}));setMessage('助理文件已保存，下一次提问生效。');}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <section className="settings-section assistant-documents"><h3>助理角色与行为</h3><p>灵魂文件定义性格，行为文件定义工作方式，用户文件记录你的偏好。内容会随提问发送给模型，请勿填写密钥或私密资料。</p>
    {!documents?<Button disabled={busy} onClick={()=>void load()}>编辑助理文件</Button>:<>
      <label>助理文件<select value={name} disabled={busy||dirty} onChange={e=>{setName(e.target.value);setText(documents.files.find(f=>f.name===e.target.value)?.text||'');setMessage('');setError('');}}><option value="SOUL.md">SOUL.md · 性格与表达</option><option value="AGENTS.md">AGENTS.md · 工作规范</option><option value="USER.md">USER.md · 用户偏好</option></select></label>
      <textarea aria-label="助理文件内容" value={text} disabled={busy} onChange={e=>setText(e.target.value)} rows={12}/>
      <p className="document-path">{documents.directory}</p><div className="button-row"><Button disabled={busy||!dirty} onClick={()=>void save()}>保存助理文件</Button><Button disabled={busy} onClick={()=>void load()}>{dirty?'放弃修改并重新加载':'重新加载文件'}</Button></div><p>角色文件需要单独保存，“保存报告目录”只保存目录。{dirty?'当前有未保存的文件修改。':''}</p>
    </>}{message&&<p role="status">{message}</p>}{error&&<p role="alert" className="inline-error">{error}</p>}
  </section>;
}
