import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeft, ArrowRight, ArrowSquareOut, PushPin, X } from '@phosphor-icons/react';
import { api } from './api';
import { MarkdownView } from './AssistantMarkdown';
import { previewPosition, type FilePreviewData } from './filePreviewModel';
import type { PreviewTarget } from './useFilePreview';
import type { Entry } from './types';
import './filePreview.css';

interface Props {
  target:PreviewTarget;
  request:MutableRefObject<string|null>;
  generation:number;
  onClose:()=>void;
  onPin:()=>void;
  onEnter:()=>void;
  onLeave:()=>void;
  onOpen:(entry:Entry)=>void;
}
interface Cached {data:FilePreviewData;time:number;size:number}
const cache=new Map<string,Cached>();
function remember(key:string,data:FilePreviewData){
  const size=JSON.stringify(data).length;if(size>2_000_000)return;
  cache.delete(key);cache.set(key,{data,time:Date.now(),size});
  while(cache.size>6||[...cache.values()].reduce((sum,item)=>sum+item.size,0)>6_000_000)cache.delete(cache.keys().next().value!);
}

export function FilePreview({target,request,generation,onClose,onPin,onEnter,onLeave,onOpen}:Props) {
  const {entry,anchor,pinned}=target;
  const [page,setPage]=useState(1),[sheet,setSheet]=useState(0),[retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;data?:FilePreviewData;error?:string}>({key:''});
  const [viewport,setViewport]=useState({width:window.innerWidth,height:window.innerHeight});
  const panel=useRef<HTMLElement>(null);
  const key=`${entry.path}|${entry.modified}|${entry.size}|${generation}|${page}|${sheet}`;
  const data=result.key===key?result.data:undefined,error=result.key===key?result.error:undefined;
  const columns=Math.max(0,...(data?.rows||[]).map(row=>row.length));
  useEffect(()=>{const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{
    let alive=true;
    const cached=cache.get(key);
    if(cached&&Date.now()-cached.time<30_000){setResult({key,data:cached.data});return;}
    setResult({key});
    const requestId=crypto.randomUUID();request.current=requestId;
    const timer=setTimeout(()=>{if(alive){alive=false;setResult({key,error:'预览加载超时，可重试或用原程序打开。'});void api('cancel_file_preview',{requestId}).catch(()=>{});}},15_000);
    void api<FilePreviewData>('file_preview',{path:entry.path,requestId,page,sheet}).then(value=>{
      if(!alive||request.current!==requestId)return;
      clearTimeout(timer);remember(key,value);setResult({key,data:value});
    }).catch(reason=>{if(alive&&request.current===requestId){clearTimeout(timer);setResult({key,error:String(reason)});}});
    return()=>{alive=false;clearTimeout(timer);if(request.current===requestId)request.current=null;void api('cancel_file_preview',{requestId}).catch(()=>{});};
  },[key,retry,entry.path,page,sheet,request]);
  useEffect(()=>{if(pinned)panel.current?.focus({preventScroll:true});},[pinned]);
  return <section className={`file-preview ${pinned?'pinned':''}`} role="dialog" aria-label={`文件预览：${entry.name}`} aria-modal="false" tabIndex={-1} ref={panel}
    style={previewPosition(anchor,viewport.width,viewport.height)} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
    <header className="file-preview-head"><div><span>{pinned?'固定预览':'文件预览'}</span><strong title={entry.path}>{entry.name}</strong></div>
      {!pinned&&<button type="button" className="icon-button" aria-label="固定文件预览" title="固定预览" onClick={onPin}><PushPin size={17}/></button>}
      <button type="button" className="icon-button" aria-label="关闭文件预览" title="关闭预览" onClick={onClose}><X size={18}/></button>
    </header>
    {(data?.sheets||(data?.pageCount||0)>1)&&<div className="file-preview-controls">
      {data?.sheets&&<label>工作表 <select aria-label="预览工作表" value={sheet} onChange={event=>{onPin();setSheet(Number(event.target.value));}}>{data.sheets.map((name,index)=><option key={index} value={index}>{name}</option>)}</select></label>}
      {(data?.pageCount||0)>1&&<><button type="button" aria-label="预览上一页" disabled={page<=1} onClick={()=>{onPin();setPage(value=>value-1);}}><ArrowLeft size={16}/></button><span>第 {page} / {data?.pageCount} 页</span><button type="button" aria-label="预览下一页" disabled={page>=data!.pageCount!} onClick={()=>{onPin();setPage(value=>value+1);}}><ArrowRight size={16}/></button></>}
    </div>}
    <div className="file-preview-body" key={key}>
      {error?<div className="file-preview-message" role="alert"><p>{error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>重试预览</button></div>:!data?<div className="file-preview-message" role="status">正在读取本地文件…</div>:
        data.kind==='image'?<div className="file-preview-image"><img src={data.image} alt={`${entry.name} 第 ${data.page||1} 页`}/></div>:
        data.kind==='table'?data.rows?.length?<table className="file-preview-table"><thead><tr><th aria-label="行号">#</th>{Array.from({length:columns},(_,index)=><th key={index}>{String.fromCharCode(65+index)}</th>)}</tr></thead><tbody>{data.rows.map((row,index)=><tr key={index}><th scope="row">{index+1}</th>{Array.from({length:columns},(_,column)=><td key={column}>{row[column]||''}</td>)}</tr>)}</tbody></table>:<p className="file-preview-message">此工作表没有可预览的数据。</p>:
        data.format==='markdown'?<MarkdownView text={data.text||''}/>:<pre className="file-preview-text">{data.text||'此文件没有可预览的文字。'}</pre>}
    </div>
    <footer className="file-preview-footer"><span>{data?.truncated?'内容已截取 · ':''}{data?.notice||'仅在本机预览'}{!pinned&&' · Ctrl＋左键可固定'}</span><button type="button" onClick={()=>onOpen(entry)}><ArrowSquareOut size={15}/>打开文件</button></footer>
  </section>;
}
