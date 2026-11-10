import { useCallback, useEffect, useState } from 'react';
import { demo } from './api';
import { basename, cleanPath, renamedPath } from './domain';
import type { Entry } from './types';

export interface RecentItem { key:string; kind:'file'|'directory'; name:string; path:string; opened:true }
const storageKey=demo?'office-demo-recent':'office-recent';
function read():RecentItem[] {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(storageKey)||'[]');
    // Keep explicit opens from older versions. Old tool launches are discarded on save.
    return Array.isArray(value) ? value.filter((item):item is RecentItem=>
      item?.opened===true && (item.kind==='file'||item.kind==='directory') &&
      typeof item.key==='string' && typeof item.name==='string' && typeof item.path==='string'
    ).slice(0,100) : [];
  }catch{return [];}
}
export function useQuickHistory() {
  const [items,setItems]=useState(read),[error,setError]=useState('');
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(items));setError('');}catch{setError('无法保存最近访问记录，本次记录仅在当前窗口保留。');}},[items]);
  const opened=useCallback((entry:Pick<Entry,'path'|'name'|'isDir'>)=>{
    const item:RecentItem={key:`path:${cleanPath(entry.path).toLowerCase()}`,kind:entry.isDir?'directory':'file',name:entry.name,path:entry.path,opened:true};
    setItems(previous=>[item,...previous.filter(record=>record.key!==item.key)].slice(0,100));
  },[]);
  const relocate=useCallback((from:string,to:string)=>setItems(items=>{
    const mapped=items.map(item=>{const path=renamedPath(item.path,from,to);return path===item.path?item:{...item,path,name:basename(path),key:`path:${cleanPath(path).toLowerCase()}`};});
    return mapped.filter((item,i)=>mapped.findIndex(other=>other.key===item.key)===i);
  }),[]);
  return {items,error,opened,relocate,remove:(key:string)=>setItems(items=>items.filter(item=>item.key!==key)),clear:()=>setItems([])};
}
