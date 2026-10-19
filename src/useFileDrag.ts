import { useRef, type HTMLAttributes } from 'react';
import { api, desktop } from './api';
import type { Entry } from './types';

export function useFileDrag(onError:(error:string)=>void,onStart:()=>void){
  const origin=useRef<{path:string;x:number;y:number;pointer:number}|null>(null);
  const active=useRef(false),suppressClick=useRef<{path:string;until:number}|null>(null);
  return (entry:Entry):HTMLAttributes<HTMLDivElement>=>({
    draggable:false,
    onPointerDownCapture:event=>{
      if(desktop&&event.button===0&&!event.ctrlKey&&!event.altKey&&!active.current)origin.current={path:entry.path,x:event.clientX,y:event.clientY,pointer:event.pointerId};
    },
    onPointerMoveCapture:event=>{
      const start=origin.current;
      if(!start||start.path!==entry.path||start.pointer!==event.pointerId)return;
      if(!(event.buttons&1)){origin.current=null;return;}
      if(Math.hypot(event.clientX-start.x,event.clientY-start.y)<8)return;
      origin.current=null;active.current=true;event.preventDefault();onStart();
      suppressClick.current={path:entry.path,until:Infinity};
      void api<{status:string}>('drag_file',{path:entry.path}).catch(error=>onError(String(error))).finally(()=>{
        active.current=false;suppressClick.current={path:entry.path,until:Date.now()+300};
      });
    },
    onPointerUpCapture:()=>{origin.current=null;},
    onPointerCancel:()=>{origin.current=null;},
    onClickCapture:event=>{
      if(suppressClick.current?.path===entry.path&&Date.now()<suppressClick.current.until){event.preventDefault();event.stopPropagation();}
    },
  });
}
