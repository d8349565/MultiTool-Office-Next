import { Button } from '@fluentui/react-components';
import { File, FolderOpen, Copy, ArrowSquareOut, CaretRight } from '@phosphor-icons/react';
import type { AIResult, Entry } from './types';
import type { Link } from './assistantState';
import { basename } from './domain';

export function AssistantResults({trace,links,onLink,onCopy,onFolderOpen,onMore}:{trace:AIResult['trace'];links:Link[];onLink:(l:Link)=>void;onCopy:(p:string)=>void;onFolderOpen:(p:string)=>void;onMore?:()=>void}){
  const rows:Entry[]=[];const seen=new Set<string>();let more=false;
  for(const t of trace||[]){const r=t.result as any;if(!['files_search','files_query','resultset_enrich','directory_tree','files_analyze','files_list_dirs'].includes(t.tool))continue;
    for(const e of (Array.isArray(r)?r:r?.items)||[])if(typeof e.path==='string'&&!seen.has(e.path)){seen.add(e.path);rows.push(e);}
    more||=!!r?.hasMore;
  }
  const fallback=links.filter(l=>!['web'].includes(l.kind)&&!seen.has(l.target)&&!(l.kind==='folder'&&rows.some(r=>r.parent===l.target)));
  return <div className="assistant-results">
    {(['file','folder'] as const).map(kind=>{const items=rows.filter(e=>kind==='folder'?e.isDir:!e.isDir);return items.length?<details className="assistant-result-group" key={kind} aria-label={kind==='file'?'文件结果':'文件夹结果'}><summary><CaretRight size={14} aria-hidden="true"/>{kind==='file'?'文件':'文件夹'} <span>{items.length}</span><span className="assistant-result-toggle" aria-hidden="true"/></summary><ul>{items.map(e=><li key={e.path}>
      <span className="assistant-result-icon" aria-hidden="true">{e.isDir?<FolderOpen size={18}/>:<File size={18}/>}</span>
      <div className="assistant-result-description"><button className="assistant-result-name" title={e.path} onClick={()=>onLink({kind:e.isDir?'folder':'file',label:e.name,target:e.path})}>{e.name}</button><span className="assistant-result-meta" title={e.parent}>{e.businessDate?`${e.businessDate} · ${e.dateSource} · `:''}{e.matchReason?`${e.matchReason} · `:''}{basename(e.parent)}</span></div>
      <div className="assistant-result-actions"><Button size="small" appearance="subtle" onClick={()=>onLink({kind:e.isDir?'folder':'file',label:e.name,target:e.path})}>{e.isDir?'进入':'定位'}</Button>{e.isDir&&<Button size="small" appearance="subtle" icon={<ArrowSquareOut/>} aria-label={`打开文件夹：${e.name}`} onClick={()=>onFolderOpen(e.path)}/>}
      <Button size="small" appearance="subtle" icon={<Copy/>} aria-label={`复制路径：${e.name}`} onClick={()=>onCopy(e.path)}/></div>
    </li>)}</ul></details>:null;})}
    {fallback.length>0&&<details className="assistant-result-links"><summary>查看结果链接（{fallback.length}）</summary><div className="assistant-links">{fallback.map(l=><button key={l.kind+':'+l.target} title={l.target} onClick={()=>onLink(l)}>{l.kind==='report'?l.label:basename(l.target)}</button>)}</div></details>}
    {more&&onMore&&<Button size="small" onClick={onMore}>查看下一页</Button>}
  </div>;
}
