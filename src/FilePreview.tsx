import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeft, ArrowRight, ArrowSquareOut, PushPin, X } from '@phosphor-icons/react';
import { api } from './api';
import { MarkdownView } from './AssistantMarkdown';
import { previewPosition, type FilePreviewData, type PreviewSize } from './filePreviewModel';
import { SheetPreview } from './SheetPreview';
import { IconButton } from './components';
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
const sizeKey='office-file-preview-size';
function savedSize():PreviewSize {
  try {
    const size=JSON.parse(localStorage.getItem(sizeKey)||'null');
    if(Number.isFinite(size?.width)&&size.width>0&&Number.isFinite(size?.height)&&size.height>0)return {width:size.width,height:size.height};
  }catch{/* 无法读取偏好时使用默认尺寸。 */}
  return {width:520,height:420};
}
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
  const [dimensions,setDimensions]=useState(savedSize),[placement,setPlacement]=useState<{left:number;top:number}|null>(null);
  const panel=useRef<HTMLElement>(null);
  const drag=useRef<{pointerId:number;corner:'start'|'end';x:number;y:number;left:number;top:number;width:number;height:number}|null>(null);
  const position=previewPosition(anchor,viewport.width,viewport.height,dimensions);
  if(placement){position.left=Math.max(12,Math.min(placement.left,viewport.width-position.width-12));position.top=Math.max(12,Math.min(placement.top,viewport.height-position.height-12));}
  function changeSize(width:number,height:number){
    const bounded=previewPosition(anchor,window.innerWidth,window.innerHeight,{width,height}),next={width:bounded.width,height:bounded.height};
    const d=drag.current;
    setPlacement({left:d?.corner==='start'?d.left+d.width-next.width:position.left,top:d?.corner==='start'?d.top+d.height-next.height:position.top});setDimensions(next);
    try{localStorage.setItem(sizeKey,JSON.stringify(next));}catch{/* 保存失败不影响本次调整。 */}
  }
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
  useEffect(()=>{if(pinned&&!panel.current?.contains(document.activeElement))panel.current?.focus({preventScroll:true});},[pinned]);
  return <section className={`file-preview ${pinned?'pinned':''}`} role="dialog" aria-label={`文件预览：${entry.name}`} aria-modal="false" tabIndex={-1} ref={panel}
    style={position} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
    <header className="file-preview-head">
      <div className="file-preview-title"><span>{pinned?'固定预览':'文件预览'}</span><strong title={entry.path}>{entry.name}</strong></div>
      <div className="file-preview-actions">
        {!pinned&&<IconButton label="固定预览" onClick={onPin}><PushPin size={16}/></IconButton>}
        <IconButton label="关闭预览" onClick={onClose}><X size={16}/></IconButton>
      </div>
    </header>
    {(data?.sheets||(data?.pageCount||0)>1)&&<div className="file-preview-controls">
      {data?.sheets&&<label className="file-preview-sheet-picker"><span>工作表</span><select aria-label="预览工作表" value={sheet} onChange={event=>{onPin();setSheet(Number(event.target.value));}}>{data.sheets.map((name,index)=><option key={index} value={index}>{name}</option>)}</select></label>}
      {(data?.pageCount||0)>1&&<div className="file-preview-pagination"><IconButton label="预览上一页" disabled={page<=1} onClick={()=>{onPin();setPage(value=>value-1);}}><ArrowLeft size={14}/></IconButton><span>第 {page} / {data?.pageCount} 页</span><IconButton label="预览下一页" disabled={page>=data!.pageCount!} onClick={()=>{onPin();setPage(value=>value+1);}}><ArrowRight size={14}/></IconButton></div>}
    </div>}
    <div className="file-preview-body" key={key}>
      {error?<div className="file-preview-message" role="alert"><p>{error}</p><Button size="small" onClick={()=>setRetry(value=>value+1)}>重试预览</Button></div>:!data?<div className="file-preview-message" role="status">正在读取本地文件…</div>:
        data.kind==='image'?<div className="file-preview-image"><img src={data.image} alt={`${entry.name} 第 ${data.page||1} 页`}/></div>:
        data.kind==='table'?data.rows?.length?data.grid?<SheetPreview rows={data.rows} grid={data.grid}/>:<table className="file-preview-table"><thead><tr><th aria-label="行号">#</th>{Array.from({length:columns},(_,index)=><th key={index}>{String.fromCharCode(65+index)}</th>)}</tr></thead><tbody>{data.rows.map((row,index)=><tr key={index}><th scope="row">{index+1}</th>{Array.from({length:columns},(_,column)=><td key={column}>{row[column]||''}</td>)}</tr>)}</tbody></table>:<p className="file-preview-message">此工作表没有可预览的数据。</p>:
        data.format==='markdown'?<MarkdownView text={data.text||''}/>:<pre className="file-preview-text">{data.text||'此文件没有可预览的文字。'}</pre>}
    </div>
    <footer className="file-preview-footer"><span>{data?.truncated?'内容已截取 · ':''}{data?.notice||'仅在本机预览'}{!pinned&&' · Ctrl＋左键可固定'}</span><Button appearance="subtle" size="small" icon={<ArrowSquareOut size={14}/>} onClick={()=>onOpen(entry)}>打开文件</Button></footer>
    {(['start','end'] as const).map(corner=><div key={corner} className={`file-preview-resize ${corner}`} role="separator" aria-label={`从${corner==='start'?'左上':'右下'}角调整文件预览窗口大小`} aria-valuetext={`${Math.round(position.width)} × ${Math.round(position.height)} 像素`} title="拖动调整大小，方向键微调" tabIndex={0}
      onPointerDown={event=>{if(event.button!==0||drag.current)return;event.preventDefault();onPin();drag.current={pointerId:event.pointerId,corner,x:event.clientX,y:event.clientY,left:position.left,top:position.top,width:position.width,height:position.height};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{const d=drag.current;if(d?.pointerId===event.pointerId){const direction=d.corner==='start'?-1:1;changeSize(d.width+(event.clientX-d.x)*direction,d.height+(event.clientY-d.y)*direction);}}}
      onPointerUp={event=>{if(drag.current?.pointerId!==event.pointerId)return;drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();onPin();changeSize(position.width+(event.key==='ArrowRight'?20:event.key==='ArrowLeft'?-20:0),position.height+(event.key==='ArrowDown'?20:event.key==='ArrowUp'?-20:0));}}/>)}
  </section>;
}
