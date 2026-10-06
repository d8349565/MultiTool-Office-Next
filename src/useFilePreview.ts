import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { api } from './api';
import type { Entry } from './types';
import type { PreviewAnchor } from './filePreviewModel';

export interface PreviewTarget { entry:Entry; anchor:PreviewAnchor; pinned:boolean }

export function useFilePreview(enabled:boolean,scope:string,entries:Entry[]) {
  const [target,setTarget]=useState<PreviewTarget|null>(null);
  const current=useRef(target);current.current=target;
  const hovering=useRef<{entry:Entry;element:HTMLElement}|null>(null),inside=useRef(false);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null),leaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const request=useRef<string|null>(null);
  const origin=useRef<HTMLElement|null>(null);
  const clearTimers=useCallback(()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);if(leaveTimer.current)clearTimeout(leaveTimer.current);hoverTimer.current=null;leaveTimer.current=null;},[]);
  const close=useCallback(()=>{
    clearTimers();current.current=null;inside.current=false;setTarget(null);
    if(document.activeElement?.closest('.file-preview')&&origin.current?.isConnected)origin.current.focus({preventScroll:true});
    if(request.current){void api('cancel_file_preview',{requestId:request.current}).catch(()=>{});request.current=null;}
  },[clearTimers]);
  const show=useCallback((entry:Entry,element:HTMLElement,pinned:boolean)=>{
    clearTimers();origin.current=element;const anchor=element.getBoundingClientRect();
    const next={entry,anchor:{left:anchor.left,right:anchor.right,top:anchor.top,bottom:anchor.bottom},pinned};
    current.current=next;setTarget(next);
  },[clearTimers]);
  const schedule=useCallback(()=>{
    const item=hovering.current;
    if(!enabled||!item||current.current?.pinned||hoverTimer.current||current.current?.entry.path===item.entry.path)return;
    hoverTimer.current=setTimeout(()=>{hoverTimer.current=null;if(hovering.current?.entry.path===item.entry.path)show(item.entry,item.element,false);},300);
  },[enabled,show]);
  const hover=(entry:Entry,event:PointerEvent<HTMLElement>)=>{
    if(leaveTimer.current)clearTimeout(leaveTimer.current);leaveTimer.current=null;
    if(hovering.current?.entry.path!==entry.path){if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=null;}
    hovering.current={entry,element:event.currentTarget};
    if(event.ctrlKey)schedule();
  };
  const leave=()=>{
    hovering.current=null;if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=null;
    if(!current.current?.pinned)leaveTimer.current=setTimeout(()=>{if(!inside.current)close();},200);
  };
  useEffect(()=>{close();hovering.current=null;},[enabled,scope,close]);
  useEffect(()=>{
    const active=current.current;if(!active)return;
    const entry=entries.find(item=>item.path===active.entry.path);
    if(!entry){close();return;}
    if(entry.modified!==active.entry.modified||entry.size!==active.entry.size)setTarget({...active,entry});
  },[entries,close]);
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{if(event.key==='Escape')close();if(event.key==='Control')schedule();};
    const up=(event:KeyboardEvent)=>{if(event.key==='Control'&&!current.current?.pinned)close();};
    const blur=()=>close();
    const outside=(event:globalThis.PointerEvent)=>{if(current.current&&event.target instanceof Element&&!event.target.closest('.file-preview'))close();};
    const scroll=(event:Event)=>{if(event.target instanceof Element&&event.target.closest('.file-list')&&!current.current?.pinned){hovering.current=null;close();}};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);window.addEventListener('pointerdown',outside);window.addEventListener('scroll',scroll,true);
    return()=>{clearTimers();window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);window.removeEventListener('pointerdown',outside);window.removeEventListener('scroll',scroll,true);};
  },[close,schedule,clearTimers]);
  return {target,request,close,hover,leave,pin:(entry:Entry,element:HTMLElement)=>show(entry,element,true),
    enterPanel:()=>{inside.current=true;if(leaveTimer.current)clearTimeout(leaveTimer.current);leaveTimer.current=null;},
    leavePanel:()=>{inside.current=false;if(!current.current?.pinned)leave();},
    pinPanel:()=>{if(current.current){const next={...current.current,pinned:true};current.current=next;setTarget(next);}}};
}
