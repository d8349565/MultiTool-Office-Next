import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowUpRight, CaretRight, FileText, FolderSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import { api } from './api';
import { isWithin, cleanPath } from './domain';
import { IconButton, Modal } from './components';
import { getLauncherVisual } from './launcherVisuals';
import { currentTool, type RecentItem } from './quickHistory';
import type { Entry, Launcher, Results } from './types';

interface Candidate {key:string;name:string;path:string;kind:'file'|'directory'|'tool';group:string;tool?:Launcher;recent?:RecentItem;invalid?:string}
export function QuickPanel({roots,launchers,history,historyError,onRemove,onClear,onLocate,onLaunch,onClose,shortcut}:{roots:string[];launchers:Launcher[];history:RecentItem[];historyError:string;onRemove:(key:string)=>void;onClear:()=>void;onLocate:(path:string,isDir:boolean)=>Promise<void>;onLaunch:(id:string)=>Promise<boolean>;onClose:()=>void;shortcut:string}) {
  const [query,setQuery]=useState(''),[results,setResults]=useState<Entry[]>([]),[busy,setBusy]=useState(false),[executing,setExecuting]=useState(false),[error,setError]=useState(''),[index,setIndex]=useState(0),[confirmClear,setConfirmClear]=useState(false);
  const list=useRef<HTMLDivElement>(null);
  const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean),matches=(name:string,path:string)=>tokens.every(t=>`${name}\n${path}`.toLowerCase().includes(t));
  useEffect(()=>{
    setIndex(0);setResults([]);setError('');
    if(!query.trim()){setBusy(false);return;}
    let alive=true;setBusy(true);
    const timer=setTimeout(()=>void Promise.all(['file','directory'].map(kind=>api<Results>('search',{query:{query:query.trim(),kind,recursive:true,limit:8}}))).then(values=>{if(alive)setResults(values.flatMap(r=>r.items));}).catch(e=>{if(alive)setError(String(e));}).finally(()=>{if(alive)setBusy(false);}),160);
    return()=>{alive=false;clearTimeout(timer);};
  },[query,roots]);
  const candidates:Candidate[]=[];
  for(const item of [...history.filter(v=>v.kind==='tool').sort((a,b)=>b.uses-a.uses||b.usedAt-a.usedAt).slice(0,tokens.length?100:8),...history.filter(v=>v.kind!=='tool')]){
    if(!matches(item.name,item.path))continue;
    const tool=item.kind==='tool'?currentTool(item,launchers):undefined;
    candidates.push({key:item.key,name:tool?.name||item.name,path:item.path,kind:item.kind,tool,recent:item,group:item.kind==='tool'?'常用工具':'最近访问',invalid:item.kind==='tool'?!tool?'工具已删除或目标已改变，请从工具列表重新选择。':undefined:!roots.some(root=>isWithin(item.path,root))?'已超出当前工作目录范围':undefined});
  }
  for(const tool of launchers){if(matches(tool.name,tool.path)&&!candidates.some(v=>v.tool?.id===tool.id))candidates.push({key:`tool:${tool.id}`,name:tool.name,path:tool.path,kind:'tool',tool,group:'工具'});}
  for(const entry of results){const key=`path:${cleanPath(entry.path).toLowerCase()}`;if(!candidates.some(v=>v.key===key))candidates.push({key,name:entry.name,path:entry.path,kind:entry.isDir?'directory':'file',group:'搜索结果'});}
  const total=candidates.length;candidates.length=Math.min(total,60);
  const selected=Math.min(index,Math.max(0,candidates.length-1));
  useEffect(()=>{list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[selected,query]);
  async function execute(item:Candidate){
    if(executing)return;if(item.invalid){setError(item.invalid);return;}
    setExecuting(true);setError('');
    try{if(item.tool){if(!await onLaunch(item.tool.id)){setError('启动失败，请检查工具是否已移动、删除或配置发生变化。');return;}}else await onLocate(item.path,item.kind==='directory');onClose();}catch(e){setError(String(e));}finally{setExecuting(false);}
  }
  function keyDown(event:KeyboardEvent<HTMLInputElement>){
    if(event.nativeEvent.isComposing||!candidates.length)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setIndex((selected+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length);}
    if(event.key==='Enter'){event.preventDefault();if(!event.repeat)void execute(candidates[selected]);}
  }
  return <Modal title="快捷面板" onClose={onClose}>
    <label className="quick-search"><MagnifyingGlass aria-hidden="true"/><span className="sr-only">搜索文件、目录与工具</span><input autoFocus role="combobox" aria-autocomplete="list" aria-expanded aria-controls="quick-results" aria-activedescendant={candidates.length?`quick-result-${selected}`:undefined} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={keyDown} placeholder="搜索文件、目录或常用工具…"/></label>
    {error&&<p className="inline-error" role="alert">{error}</p>}{historyError&&<p className="inline-error" role="alert">{historyError}</p>}
    <div className="quick-results" id="quick-results" role="listbox" aria-label="文件、目录与工具候选" ref={list} aria-busy={busy||executing}>
      {candidates.map((item,i)=>{const visual=item.tool?getLauncherVisual(item.tool):undefined,Icon=visual?.icon||(item.kind==='directory'?FolderSimple:FileText);return <div key={item.key}>
        {(i===0||candidates[i-1].group!==item.group)&&<p className="quick-group">{item.group}</p>}
        <div className="quick-row"><button type="button" id={`quick-result-${i}`} role="option" aria-selected={selected===i} aria-disabled={!!item.invalid||executing} className={`quick-option ${selected===i?'active':''}`} onMouseEnter={()=>setIndex(i)} onClick={()=>void execute(item)} title={item.path}>
          <Icon aria-hidden="true" size={21}/><span><strong>{item.name}<em>{item.kind==='tool'?'启动工具':item.kind==='directory'?'定位目录':'定位文件'}</em></strong><small>{item.invalid||item.path}</small></span>{item.kind==='tool'?<ArrowUpRight aria-hidden="true"/>:<CaretRight aria-hidden="true"/>}
        </button>{item.recent&&<IconButton label={`移除记录：${item.name}`} onClick={()=>onRemove(item.recent!.key)}><X/></IconButton>}</div>
      </div>;})}
      {!candidates.length&&<p className="muted">{busy?'正在查找…':query?'没有匹配项，请调整关键词。':'访问文件、目录或启动工具后，会在这里显示。'}</p>}
    </div>
    <div className="quick-footer"><span role="status">{executing?'正在执行…':busy?'正在查找…':total>60?'显示前 60 项，输入关键词可缩小范围':'↑↓ 选择 · Enter 执行 · Esc 关闭'}</span>{history.length>0&&(confirmClear?<><span>清空访问记录？</span><Button size="small" onClick={()=>{onClear();setConfirmClear(false);}}>清空</Button><Button size="small" onClick={()=>setConfirmClear(false)}>取消</Button></>:<Button size="small" appearance="subtle" onClick={()=>setConfirmClear(true)}>清空记录</Button>)}</div>
    <p className="notice">{shortcut}</p>
  </Modal>;
}
