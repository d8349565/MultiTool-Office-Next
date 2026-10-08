import { useEffect, useRef, useState, type ReactNode, useLayoutEffect } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { X, FolderSimple, CaretRight, ArrowSquareOut, Copy, ArrowUp, FolderOpen, MagnifyingGlass } from '@phosphor-icons/react';
import type { Entry } from './types';
import { basename, samePath } from './domain';

export function IconButton({label,children,onClick,disabled=false}:{label:string;children:ReactNode;onClick:()=>void;disabled?:boolean}) {
  return <Tooltip content={label} relationship="label"><Button appearance="subtle" size="small" icon={<>{children}</>} aria-label={label} onClick={onClick} disabled={disabled}/></Tooltip>;
}
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const d=ref.current!;d.showModal();return()=>d.close();},[]);
  return <dialog ref={ref} className={`modal ${wide?'wide':''}`} onCancel={e=>{e.preventDefault();onClose();}} aria-label={title} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X/></IconButton></header><div className="modal-body">{children}</div>
  </dialog>;
}
export function Empty({title,detail,action}:{title:string;detail?:string;action?:ReactNode}) {return <div className="empty"><FolderOpen size={32} weight="thin"/><strong>{title}</strong>{detail&&<p>{detail}</p>}{action}</div>;}
export function Skeleton(){return <div className="skeleton" aria-label="加载中">{[1,2,3,4].map(i=><div key={i}/>)}</div>;}

// Scroll position is keyed by parent. Ancestor panels stay mounted when descendants change.
export function DirectoryPanel({title,level,parent,items,selected,busy,error,onSelect,onEnter,onOpen,onCopy,onBack,className}:{title:string;level:number;parent:string;items:Entry[];selected?:string;busy:boolean;error?:string;onSelect:(e:Entry)=>void;onEnter?:(e:Entry)=>void;onOpen:(e:Entry)=>void;onCopy:(s:string)=>void;onBack?:()=>void;className?:string}) {
  const list=useRef<HTMLDivElement>(null), positions=useRef(new Map<string,number>()), interaction=useRef(false);
  const [filter,setFilter]=useState({parent,text:''});
  useEffect(()=>{setFilter(value=>value.parent===parent?value:{parent,text:''});},[parent]);
  const text=filter.parent===parent?filter.text:'';
  const query=text.trim().toLocaleLowerCase();
  const visibleItems=items.filter(e=>e.name.toLocaleLowerCase().includes(query));
  useLayoutEffect(()=>{interaction.current=false;},[parent,busy]);
  useLayoutEffect(()=>{if(!busy&&list.current){list.current.scrollTop=positions.current.get(parent)||0;}},[busy,parent,items]);
  const selectedEntry=items.find(e=>selected&&samePath(e.path,selected));
  return <section className={`directory-panel panel ${className||''}`} aria-label={title}>
    <div className="panel-head"><div className="panel-title"><span className="level">{String(level).padStart(2,'0')}</span><h2 title={title}>{title}</h2><span className="count">{text?`${visibleItems.length}/${items.length}`:items.length}</span></div><div className="panel-actions">
      {onBack&&<IconButton label="返回上级" onClick={onBack}><ArrowUp/></IconButton>}
      {selectedEntry&&<><IconButton label="复制目录名称" onClick={()=>onCopy(selectedEntry.name)}><Copy/></IconButton><IconButton label="打开所选目录" onClick={()=>onOpen(selectedEntry)}><ArrowSquareOut/></IconButton></>}
    </div></div>
    <div className="panel-parent" title={parent}>{parent?basename(parent):'选择前一级目录'}</div>
    <label className="directory-filter"><MagnifyingGlass size={13}/><input aria-label={`筛选${title}`} placeholder="查找本列文件夹" value={text} disabled={!parent} onChange={e=>{setFilter({parent,text:e.target.value});if(list.current)list.current.scrollTop=0;}} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setFilter({parent,text:''});}}}/>{text&&<button type="button" aria-label={`清除${title}筛选`} onClick={()=>setFilter({parent,text:''})}><X size={12}/></button>}</label>
    <div className="directory-list" ref={list} onWheel={()=>{interaction.current=true;}} onPointerDown={()=>{interaction.current=true;}} onKeyDown={()=>{interaction.current=true;}} onScroll={e=>{if(!busy&&interaction.current)positions.current.set(parent,e.currentTarget.scrollTop);}} role="listbox" aria-label={`${title}列表`}>
      {busy&&!items.length?<Skeleton/>:error?<div className="inline-error">{error}</div>:!items.length?<Empty title={parent?'没有子文件夹':'等待选择'} detail={parent?'文件会显示在下方':'从前一级目录继续'}/>:!visibleItems.length?<Empty title="没有匹配的文件夹" detail="试试更短的名称，或清除本列筛选"/>:visibleItems.map((e,i)=><div role="option" aria-selected={!!selected&&samePath(selected,e.path)} tabIndex={0} key={e.path} className={`directory-row ${selected&&samePath(selected,e.path)?'selected':''}`} title={e.name}
        onClick={()=>onSelect(e)} onDoubleClick={()=>onEnter?onEnter(e):onCopy(e.name)} onContextMenu={event=>{event.preventDefault();onOpen(e);}}
        onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!event.repeat)(event.key==='Enter'&&onEnter?onEnter:onSelect)(e);}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();(list.current?.querySelectorAll<HTMLElement>('[role=option]')[Math.max(0,Math.min(visibleItems.length-1,i+(event.key==='ArrowDown'?1:-1)))])?.focus();}}}>
        <FolderSimple size={20} weight={selected&&samePath(selected,e.path)?'fill':'regular'}/><span>{e.name}</span><CaretRight size={14}/>
      </div>)}
    </div>
    <div className="panel-foot">{onEnter?'单击查看文件 · 双击进入':'单击浏览'}<span>右键打开目录</span></div>
  </section>;
}

export function Splitter({axis,container,variable,min,max,minPixels,previousVariable,nextVariable}:{axis:'x'|'y';container:React.RefObject<HTMLElement|null>;variable:string;min:number;max:number;minPixels?:[number,number];previousVariable?:string;nextVariable?:string}) {
  function apply(value:number){
    const el=container.current;if(!el)return;let low=min,high=max;
    if(minPixels){const rect=el.getBoundingClientRect(),size=axis==='x'?rect.width:rect.height;if(!size)return;const before=previousVariable?parseFloat(el.style.getPropertyValue(previousVariable)):0,after=nextVariable?parseFloat(el.style.getPropertyValue(nextVariable)):100;low=Math.max(low,before+(minPixels[0]+(previousVariable?10:0))/size*100);high=Math.min(high,after-(minPixels[1]+10)/size*100);}
    const next=Math.max(low,Math.min(high,value));el.style.setProperty(variable,`${next}%`);try{localStorage.setItem(`office-${variable}`,`${next}%`);}catch{/* Resizing works when preference storage is unavailable. */}
  }
  function update(client:number){const el=container.current;if(!el)return;const rect=el.getBoundingClientRect();apply((client-(axis==='x'?rect.left:rect.top))/(axis==='x'?rect.width:rect.height)*100);}
  return <div className={`splitter ${axis} ${variable.slice(2)}`} role="separator" aria-label="调整面板大小" aria-orientation={axis==='x'?'vertical':'horizontal'} tabIndex={0}
    onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.dataset.drag='true';}}
    onPointerMove={e=>{if(e.currentTarget.dataset.drag==='true')update(axis==='x'?e.clientX:e.clientY);}}
    onPointerUp={e=>{e.currentTarget.dataset.drag='false';if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
    onPointerCancel={e=>{e.currentTarget.dataset.drag='false';}}
    onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const el=container.current;if(el){const value=parseFloat(el.style.getPropertyValue(variable))||50;apply(value+(['ArrowLeft','ArrowUp'].includes(e.key)?-2:2));}}}/>
}
