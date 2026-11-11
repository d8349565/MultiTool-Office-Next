import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeft, ArrowRight, ArrowSquareOut, PushPin, X } from '@phosphor-icons/react';
import { api } from './api';
import { MarkdownView } from './AssistantMarkdown';
import { previewPosition, type FilePreviewData, type PreviewLayout } from './filePreviewModel';
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
const layoutKey='office-file-preview-layout';
function savedLayout():PreviewLayout {
  try {
    const layout=JSON.parse(localStorage.getItem(layoutKey)||localStorage.getItem('office-file-preview-size')||'null');
    if(Number.isFinite(layout?.width)&&layout.width>0&&Number.isFinite(layout?.height)&&layout.height>0)return {
      width:layout.width,height:layout.height,
      ...(Number.isFinite(layout.left)&&Number.isFinite(layout.top)?{left:layout.left,top:layout.top}:{}),
    };
  }catch{/* 无法读取偏好时使用默认尺寸。 */}
  return {width:520,height:420};
}
function remember(key:string,data:FilePreviewData){
  const size=JSON.stringify(data).length;if(size>2_000_000)return;
  cache.delete(key);cache.set(key,{data,time:Date.now(),size});
  while(cache.size>6||[...cache.values()].reduce((sum,item)=>sum+item.size,0)>6_000_000)cache.delete(cache.keys().next().value!);
}

export function FilePreview({target,request,generation,onClose,onPin,onEnter,onLeave,onOpen}:Props) {
  const {entry,pinned}=target;
  const [page,setPage]=useState(1),[sheet,setSheet]=useState(0),[retry,setRetry]=useState(0);
  const [loaded,setLoaded]=useState<{fileKey:string;key:string;data:FilePreviewData}|null>(null);
  const [failed,setFailed]=useState<{key:string;error:string}|null>(null);
  const [viewport,setViewport]=useState({width:window.innerWidth,height:window.innerHeight});
  const [layout,setLayout]=useState(savedLayout);
  const panel=useRef<HTMLElement>(null);
  const drag=useRef<{pointerId:number;mode:'move'|'start'|'end';x:number;y:number;left:number;top:number;width:number;height:number}|null>(null);
  const position=previewPosition(viewport.width,viewport.height,layout);
  function changeLayout(next:PreviewLayout){
    const bounded=previewPosition(window.innerWidth,window.innerHeight,next);
    setLayout(bounded);
    try{localStorage.setItem(layoutKey,JSON.stringify(bounded));}catch{/* 保存失败不影响本次调整。 */}
  }
  function changeSize(width:number,height:number,corner:'start'|'end',base=position){
    const bounded=previewPosition(window.innerWidth,window.innerHeight,{width,height});
    const next={width:Math.min(bounded.width,corner==='start'?base.left+base.width-12:window.innerWidth-base.left-12),height:Math.min(bounded.height,corner==='start'?base.top+base.height-12:window.innerHeight-base.top-12)};
    changeLayout({...next,left:corner==='start'?base.left+base.width-next.width:base.left,top:corner==='start'?base.top+base.height-next.height:base.top});
  }
  function startDrag(event:PointerEvent<HTMLElement>,mode:'move'|'start'|'end'){
    if(event.button!==0||drag.current)return;
    event.preventDefault();event.currentTarget.focus({preventScroll:true});onPin();
    drag.current={...position,pointerId:event.pointerId,mode,x:event.clientX,y:event.clientY};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event:PointerEvent<HTMLElement>){
    const d=drag.current;if(d?.pointerId!==event.pointerId)return;
    const dx=event.clientX-d.x,dy=event.clientY-d.y;
    if(d.mode==='move')changeLayout({width:d.width,height:d.height,left:d.left+dx,top:d.top+dy});
    else{const direction=d.mode==='start'?-1:1;changeSize(d.width+dx*direction,d.height+dy*direction,d.mode,d);}
  }
  function endDrag(event:PointerEvent<HTMLElement>){
    if(drag.current?.pointerId!==event.pointerId)return;
    drag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const fileKey=`${entry.path}|${entry.modified}|${entry.size}|${generation}`;
  const key=`${fileKey}|${page}|${sheet}`;
  const data=loaded?.key===key?loaded.data:undefined,error=failed?.key===key?failed.error:undefined;
  const navigation=loaded?.fileKey===fileKey?loaded.data:undefined;
  const pageCount=navigation?.pageCount??0;
  const columns=Math.max(0,...(data?.rows||[]).map(row=>row.length));
  useEffect(()=>{const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{
    let alive=true;
    const cached=cache.get(key);
    setFailed(null);
    if(cached&&Date.now()-cached.time<30_000){setLoaded({fileKey,key,data:cached.data});return;}
    const requestId=crypto.randomUUID();request.current=requestId;
    const timer=setTimeout(()=>{if(alive){alive=false;setFailed({key,error:'预览加载超时，可重试或用原程序打开。'});void api('cancel_file_preview',{requestId}).catch(()=>{});}},15_000);
    void api<FilePreviewData>('file_preview',{path:entry.path,requestId,page,sheet}).then(value=>{
      if(!alive||request.current!==requestId)return;
      clearTimeout(timer);remember(key,value);setLoaded({fileKey,key,data:value});
    }).catch(reason=>{if(alive&&request.current===requestId){clearTimeout(timer);setFailed({key,error:String(reason)});}});
    return()=>{alive=false;clearTimeout(timer);if(request.current===requestId)request.current=null;void api('cancel_file_preview',{requestId}).catch(()=>{});};
  },[fileKey,key,retry,entry.path,page,sheet,request]);
  useEffect(()=>{if(pinned&&!panel.current?.contains(document.activeElement))panel.current?.focus({preventScroll:true});},[pinned]);
  return <section className={`file-preview ${pinned?'pinned':''}`} role="dialog" aria-label={`文件预览：${entry.name}`} aria-modal="false" tabIndex={-1} ref={panel}
    style={position} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
    <header className="file-preview-head">
      <div className="file-preview-title" role="group" aria-label="移动文件预览窗口" tabIndex={0} title="拖动标题移动，方向键微调"
        onPointerDown={event=>startDrag(event,'move')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();onPin();changeLayout({...position,left:position.left+(event.key==='ArrowRight'?20:event.key==='ArrowLeft'?-20:0),top:position.top+(event.key==='ArrowDown'?20:event.key==='ArrowUp'?-20:0)});}}>
        <span>{pinned?'固定预览':'文件预览'}</span><strong title={entry.path}>{entry.name}</strong>
      </div>
      <div className="file-preview-actions">
        {!pinned&&<IconButton label="固定预览" onClick={onPin}><PushPin size={16}/></IconButton>}
        <IconButton label="关闭预览" onClick={onClose}><X size={16}/></IconButton>
      </div>
    </header>
    {(navigation?.sheets||pageCount>1)&&<div className="file-preview-controls">
      {navigation?.sheets&&<label className="file-preview-sheet-picker"><span>工作表</span><select aria-label="预览工作表" value={sheet} onChange={event=>{onPin();setSheet(Number(event.target.value));}}>{navigation.sheets.map((name,index)=><option key={index} value={index}>{name}</option>)}</select></label>}
      {pageCount>1&&<div className="file-preview-pagination"><IconButton label="预览上一页" disabled={page<=1} onClick={()=>{onPin();setPage(value=>value-1);}}><ArrowLeft size={14}/></IconButton><span>第 {page} / {pageCount} 页</span><IconButton label="预览下一页" disabled={page>=pageCount} onClick={()=>{onPin();setPage(value=>value+1);}}><ArrowRight size={14}/></IconButton></div>}
    </div>}
    <div className="file-preview-body" key={key}>
      {error?<div className="file-preview-message" role="alert"><p>{error}</p><Button size="small" onClick={()=>setRetry(value=>value+1)}>重试预览</Button></div>:!data?<div className="file-preview-message" role="status">正在读取本地文件…</div>:
        data.kind==='image'?<div className="file-preview-image"><img src={data.image} alt={`${entry.name} 第 ${data.page||1} 页`}/></div>:
        data.kind==='table'?data.rows?.length?data.grid?<SheetPreview rows={data.rows} grid={data.grid}/>:<table className="file-preview-table"><thead><tr><th aria-label="行号">#</th>{Array.from({length:columns},(_,index)=><th key={index}>{String.fromCharCode(65+index)}</th>)}</tr></thead><tbody>{data.rows.map((row,index)=><tr key={index}><th scope="row">{index+1}</th>{Array.from({length:columns},(_,column)=><td key={column}>{row[column]||''}</td>)}</tr>)}</tbody></table>:<p className="file-preview-message">此工作表没有可预览的数据。</p>:
        data.format==='markdown'?<MarkdownView text={data.text||''}/>:<pre className="file-preview-text">{data.text||(data.pageCount?'此页没有可预览的文字。':data.pageCount===0?'演示文稿没有幻灯片。':'此文件没有可预览的文字。')}</pre>}
    </div>
    <footer className="file-preview-footer"><span>{data?.truncated?'内容已截取 · ':''}{data?.notice||'仅在本机预览'}{!pinned&&' · 点击图钉固定'}</span><Button appearance="subtle" size="small" icon={<ArrowSquareOut size={14}/>} onClick={()=>onOpen(entry)}>打开文件</Button></footer>
    {(['start','end'] as const).map(corner=><div key={corner} className={`file-preview-resize ${corner}`} role="separator" aria-label={`从${corner==='start'?'左上':'右下'}角调整文件预览窗口大小`} aria-valuetext={`${Math.round(position.width)} × ${Math.round(position.height)} 像素`} title="拖动调整大小，方向键微调" tabIndex={0}
      onPointerDown={event=>startDrag(event,corner)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();onPin();const direction=corner==='start'?-1:1;changeSize(position.width+(event.key==='ArrowRight'?20:event.key==='ArrowLeft'?-20:0)*direction,position.height+(event.key==='ArrowDown'?20:event.key==='ArrowUp'?-20:0)*direction,corner);}}/>)}
  </section>;
}
