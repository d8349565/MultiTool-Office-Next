import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { FolderSimple, FunnelSimple, X } from '@phosphor-icons/react';
import { api } from './api';
import { basename, relativePath } from './domain';
import { IconButton } from './components';
import type { Entry, Results, Status } from './types';

export function DirectoryFilter({root,status,value,onPick,onClear}:{root:string;status:Status;value:string;onPick:(entry:Entry)=>Promise<void>;onClear:()=>void}) {
  const [text,setText]=useState(''),[open,setOpen]=useState(false),[offset,setOffset]=useState(0),[index,setIndex]=useState(0);
  const [result,setResult]=useState<Results>({items:[],total:0}),[busy,setBusy]=useState(false),[picking,setPicking]=useState(false),[error,setError]=useState('');
  const container=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{setText('');setOpen(false);setOffset(0);},[root]);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(!container.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
  },[]);
  useEffect(()=>{
    if(!open||!root)return;
    let alive=true;setBusy(true);setError('');setResult({items:[],total:0});setIndex(0);
    const timer=setTimeout(()=>void api<Results>('search',{query:{kind:'directory',query:text.trim().replaceAll('\\','/'),root,recursive:true,offset,limit:40}}).then(value=>{if(alive)setResult(value);}).catch(e=>{if(alive)setError(String(e));}).finally(()=>{if(alive)setBusy(false);}),180);
    return()=>{alive=false;clearTimeout(timer);};
  },[open,root,text,offset,status.generation]);
  useEffect(()=>{container.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[index]);
  async function choose(entry:Entry){if(picking)return;setPicking(true);setError('');try{await onPick(entry);setText('');setOpen(false);}catch(e){setError(String(e));}finally{setPicking(false);}}
  function keyDown(event:KeyboardEvent<HTMLInputElement>){
    if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);setIndex(v=>Math.max(0,Math.min(result.items.length-1,v+(event.key==='ArrowDown'?1:-1))));}
    if(event.key==='Enter'&&open&&!busy&&result.items[index]){event.preventDefault();if(!event.repeat)void choose(result.items[index]);}
  }
  return <div className="directory-filter" ref={container} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}>
    <div className={`filter-field ${value?'has-value':''}`}>
      <FunnelSimple aria-hidden="true"/><input ref={input} aria-label="筛选目录" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls="directory-options" aria-activedescendant={open&&result.items[index]?`directory-option-${index}`:undefined} disabled={!root||picking} value={open?text:value?basename(value):text} title={value||'在当前工作根目录内按目录名或相对路径查找'} placeholder="筛选目录…" onFocus={()=>setOpen(true)} onClick={()=>setOpen(true)} onChange={e=>{setText(e.target.value);setOffset(0);setOpen(true);}} onKeyDown={keyDown}/>
      {(text||value)&&<IconButton label="清除目录筛选" onClick={()=>{setText('');setOffset(0);onClear();setOpen(false);input.current?.focus();}}><X/></IconButton>}
    </div>
    {open&&<div className="directory-candidates">
      <p className="candidate-hint" title={root}>查找 {basename(root)} 中所有层级的目录 · 选定后限定文件范围</p>
      <div className="directory-options" id="directory-options" role="listbox" aria-label="跨层目录候选" aria-busy={busy||picking}>
        {error?<p className="inline-error" role="alert">{error}</p>:busy?<p role="status">正在查找目录…</p>:!result.items.length?<p role="status">{status.scanning?'索引尚未完成，当前已索引范围内没有命中。':'没有匹配目录，请调整关键词或查看索引状态。'}</p>:result.items.map((entry,i)=><button type="button" role="option" aria-selected={i===index} id={`directory-option-${i}`} key={entry.path} title={entry.path} disabled={picking} onMouseEnter={()=>setIndex(i)} onClick={()=>void choose(entry)}><FolderSimple aria-hidden="true"/><span><strong>{entry.name}</strong><small>{relativePath(entry.path,root)||'工作根目录'}</small></span></button>)}
      </div>
      {!error&&!busy&&result.total>40&&<div className="candidate-pages"><Button size="small" disabled={!offset||picking} onClick={()=>setOffset(v=>Math.max(0,v-40))}>上一页</Button><span>{offset+1}–{Math.min(offset+40,result.total)} / {result.total}</span><Button size="small" disabled={offset+40>=result.total||picking} onClick={()=>setOffset(v=>v+40)}>下一页</Button></div>}
      <p className="candidate-hint" role="status">{status.scanning?'正在索引，结果会继续更新。':status.errors.length?'部分目录无法索引，请查看“更多筛选与索引状态”。':'↑↓ 选择 · Enter 定位 · Esc 收起；输入时不会跳转。'}</p>
    </div>}
  </div>;
}
