import { useRef, useState, type PointerEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { api, desktop } from './api';
import type { OcrRegion } from './ocrTypes';

export function OcrRegions({regions,fieldKeys,onChange}:{regions:OcrRegion[];fieldKeys:string[];onChange:(regions:OcrRegion[])=>void}) {
  const [sample,setSample]=useState(''),[page,setPage]=useState(1),[previewPage,setPreviewPage]=useState(1);
  const [image,setImage]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [draft,setDraft]=useState<OcrRegion|null>(null);
  const start=useRef<{x:number;y:number}|null>(null), input=useRef<HTMLInputElement>(null);
  async function preview(path:string,n:number) {
    setLoading(true);setError('');setImage('');setDraft(null);start.current=null;
    try { const result=await api<{image:string;page:number}>('ocr_preview_sample',{path,page:n});setImage(result.image);setPreviewPage(result.page); }
    catch(e){setError(String(e));}finally{setLoading(false);}
  }
  async function choose() {
    if(!desktop){input.current?.click();return;}
    const {open}=await import('@tauri-apps/plugin-dialog');
    const path=await open({multiple:false,filters:[{name:'PDF / 图片',extensions:['pdf','png','jpg','jpeg','bmp','tif','tiff']}]});
    if(typeof path==='string'){setSample(path);setPage(1);await preview(path,1);}
  }
  function point(e:PointerEvent<HTMLDivElement>) {
    const r=e.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
  }
  function box(e:PointerEvent<HTMLDivElement>):OcrRegion|null {
    if(!start.current)return null;const p=point(e),a=start.current;
    return {page:previewPage,x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),width:Math.abs(a.x-p.x),height:Math.abs(a.y-p.y)};
  }
  return <section className="ocr-region-editor" aria-label="模板识别区域">
    <h3>样本框选识别区域</h3>
    <p className="muted">选择本地 PDF 或图片，在样本上拖动框选 1–20 个区域。未绑定字段的区域用于裁剪识别；绑定任意字段后，整页识别以保留上下文，该字段只从绑定区域内取值。换版式时请重新预览核对区域。区域按页面比例保存，样本图不保存、不上传。</p>
    <div className="ocr-buttons"><Button disabled={loading} onClick={()=>void choose()}>选择样本</Button><label>预览页码 <input aria-label="样本页码" className="ocr-small-number" type="number" min={1} max={10000} value={page} onChange={e=>setPage(Number(e.target.value))}/></label><Button disabled={!sample||loading||!desktop||!Number.isInteger(page)||page<1||page>10000} onClick={()=>void preview(sample,page)}>加载页面</Button>{loading&&<span role="status">正在渲染样本…</span>}</div>
    <input ref={input} type="file" className="sr-only" aria-label="选择图片样本" accept="image/png,image/jpeg,image/bmp" onChange={e=>{
      const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{setImage(String(reader.result));setSample(file.name);setPage(1);setPreviewPage(1);setError('');};reader.readAsDataURL(file);e.target.value='';
    }}/>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {image&&<><p className="ocr-region-count" role="status">已设置 {regions.length}/20 个区域{regions.length===20?'，如需重画请先删除一个区域':''}</p><div className="ocr-region-canvas" aria-label="拖动框选识别区域" onPointerDown={e=>{if(e.button!==0||regions.length>=20)return;e.currentTarget.setPointerCapture(e.pointerId);start.current=point(e);setDraft(null);}} onPointerMove={e=>setDraft(box(e))} onPointerCancel={()=>{start.current=null;setDraft(null);}} onPointerUp={e=>{const r=box(e);start.current=null;setDraft(null);if(r&&r.width>.005&&r.height>.005&&regions.length<20)onChange([...regions,r]);}}>
      <img src={image} alt={`样本第 ${previewPage} 页`} draggable={false}/>
      {[...regions.filter(r=>r.page===0||r.page===previewPage),...(draft?[draft]:[])].map((r,i)=><span key={i} className="ocr-region-box" style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`}}>{i+1}{r.fieldKey?` · ${r.fieldKey}`:""}</span>)}
    </div></>}
    {regions.map((r,i)=><div className="ocr-buttons" key={i}><span>区域 {i+1} · {r.page===0?'所有选定页面':`第 ${r.page} 页`} · 宽 {(r.width*100).toFixed(1)}% × 高 {(r.height*100).toFixed(1)}%</span><label>绑定字段 <select aria-label={`区域 ${i+1} 绑定字段`} value={r.fieldKey||""} onChange={e=>onChange(regions.map((v,n)=>n===i?{...v,fieldKey:e.target.value||null}:v))}><option value="">不绑定（裁剪识别）</option>{fieldKeys.map(key=><option key={key} value={key}>{key}</option>)}</select></label><Button size="small" onClick={()=>onChange(regions.map((v,n)=>n===i?{...v,page:v.page===0?previewPage:0}:v))}>{r.page===0?'仅当前页':'应用所有页'}</Button><Button size="small" onClick={()=>onChange(regions.filter((_,n)=>n!==i))}>删除区域 {i+1}</Button></div>)}
    {!!regions.length&&<Button size="small" onClick={()=>onChange([])}>清除全部区域</Button>}
  </section>;
}
