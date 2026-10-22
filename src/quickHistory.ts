import { useCallback, useEffect, useState } from 'react';
import { demo } from './api';
import { cleanPath, openActionKey } from './domain';
import type { Entry, Launcher } from './types';

export interface RecentItem { key:string; kind:'file'|'directory'|'tool'; name:string; path:string; launcherId?:string; usedAt:number; uses:number }
const storageKey=demo?'office-demo-recent':'office-recent';
function read():RecentItem[] {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(storageKey)||'[]');
    return Array.isArray(value)?value.filter((v):v is RecentItem=>v&&typeof v.key==='string'&&['file','directory','tool'].includes(v.kind)&&typeof v.name==='string'&&typeof v.path==='string'&&Number.isFinite(v.usedAt)&&Number.isFinite(v.uses)).slice(0,100):[];
  }catch{return [];}
}
export function useQuickHistory() {
  const [items,setItems]=useState(read),[error,setError]=useState('');
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(items));setError('');}catch{setError('无法保存最近访问记录，本次记录仅在当前窗口保留。');}},[items]);
  const update=useCallback((change:(items:RecentItem[])=>RecentItem[])=>{
    setItems(change);
  },[]);
  const record=useCallback((item:Omit<RecentItem,'usedAt'|'uses'>)=>update(previous=>{
    const old=previous.find(v=>v.key===item.key);
    return [{...item,usedAt:Date.now(),uses:(old?.uses||0)+1},...previous.filter(v=>v.key!==item.key)].slice(0,100);
  }),[update]);
  const visit=useCallback((entry:Pick<Entry,'path'|'name'|'isDir'>)=>record({key:`path:${cleanPath(entry.path).toLowerCase()}`,kind:entry.isDir?'directory':'file',name:entry.name,path:entry.path}),[record]);
  const launch=useCallback((tool:Launcher)=>record({key:`tool:${tool.id}`,kind:'tool',name:tool.name,path:tool.path,launcherId:tool.id}),[record]);
  return {items,error,visit,launch,remove:(key:string)=>update(items=>items.filter(v=>v.key!==key)),clear:()=>update(()=>[])};
}
export function currentTool(item:RecentItem,tools:Launcher[]) {
  try{return tools.find(tool=>tool.id===item.launcherId&&openActionKey(tool.path)===openActionKey(item.path));}catch{return undefined;}
}
