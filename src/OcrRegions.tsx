import { useRef, useState, type PointerEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { Files, Scan } from '@phosphor-icons/react';
import { api, desktop } from './api';
import { basename } from './domain';
import type { OcrRegion } from './ocrTypes';

export function OcrRegions({regions,fieldKeys,onChange,disabled=false}:{regions:OcrRegion[];fieldKeys:string[];onChange:(regions:OcrRegion[])=>void;disabled?:boolean}) {
  const [sample,setSample]=useState(''),[page,setPage]=useState(1),[previewPage,setPreviewPage]=useState(1);
  const [image,setImage]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [draft,setDraft]=useState<OcrRegion|null>(null);
  const [confirmClear,setConfirmClear]=useState(false);
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
    <div className="ocr-section-heading"><div><h3>在样本上设置识别范围</h3><p className="muted">选择 PDF 或图片，拖动框选后绑定字段。区域按页面比例保存，样本不保存、不上传。</p></div><Button icon={<Files/>} disabled={loading} onClick={()=>void choose()}>{sample?'更换样本':'选择样本'}</Button></div>
    {sample&&<div className="ocr-region-toolbar"><span title={sample}>{basename(sample)}</span><div className="ocr-buttons"><label>预览页码 <input aria-label="样本页码" className="ocr-small-number" type="number" min={1} max={10000} value={page} onChange={e=>setPage(Number(e.target.value))}/></label><Button disabled={loading||!desktop||!Number.isInteger(page)||page<1||page>10000} onClick={()=>void preview(sample,page)}>加载页面</Button></div></div>}
    <input ref={input} type="file" className="sr-only" aria-label="选择图片样本" accept="image/png,image/jpeg,image/bmp" onChange={e=>{
      const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{setImage(String(reader.result));setSample(file.name);setPage(1);setPreviewPage(1);setError('');};reader.readAsDataURL(file);e.target.value='';
    }}/>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="ocr-region-layout"><div className="ocr-region-preview">
    {loading&&<p className="muted" role="status">正在渲染样本…</p>}
    {!loading&&!image&&<div className="ocr-region-placeholder"><Scan size={32} aria-hidden="true"/><h3>{sample?'样本暂未显示':'选择样本，开始框选'}</h3><p className="muted">{sample?'请重新加载页面或更换样本。':regions.length?'已有区域已保留。重新选择样本即可查看并调整。':'在预览中拖动鼠标添加区域，最多可设置 20 个。'}</p></div>}
    {image&&<div className="ocr-region-canvas" aria-label="拖动框选识别区域" onPointerDown={e=>{if(disabled||e.button!==0||regions.length>=20)return;e.currentTarget.setPointerCapture(e.pointerId);start.current=point(e);setDraft(null);}} onPointerMove={e=>{if(!disabled)setDraft(box(e));}} onPointerCancel={()=>{start.current=null;setDraft(null);}} onPointerUp={e=>{const r=box(e);start.current=null;setDraft(null);if(!disabled&&r&&r.width>.005&&r.height>.005&&regions.length<20)onChange([...regions,r]);}}>
      <img src={image} alt={`样本第 ${previewPage} 页`} draggable={false}/>
      {regions.map((r,i)=>(r.page===0||r.page===previewPage)&&<span key={i} className="ocr-region-box" style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`}}>{i+1}{r.fieldKey?` · ${r.fieldKey}`:''}</span>)}
      {draft&&<span className="ocr-region-box" style={{left:`${draft.x*100}%`,top:`${draft.y*100}%`,width:`${draft.width*100}%`,height:`${draft.height*100}%`}}>{regions.length+1}</span>}
    </div>}
    </div><aside className="ocr-region-sidebar" aria-label="已配置的识别区域">
      <div className="ocr-section-heading"><h3>识别区域</h3><span className="muted" role="status">{regions.length} / 20</span></div>
      {!regions.length&&<p className="muted">尚未框选，当前按整页识别。</p>}
      {regions.length===20&&<p className="muted">已达上限，请先删除一个区域再框选。</p>}
      {regions.map((r,i)=><div className="ocr-region-item" key={i}><div className="ocr-section-heading"><strong>区域 {i+1}</strong><Button size="small" appearance="subtle" aria-label={`删除区域 ${i+1}`} onClick={()=>onChange(regions.filter((_,n)=>n!==i))}>删除</Button></div><span className="muted">{r.page===0?'所有选定页面':`第 ${r.page} 页`} · 宽 {(r.width*100).toFixed(1)}% × 高 {(r.height*100).toFixed(1)}%</span><label className="ocr-field">绑定字段<select aria-label={`区域 ${i+1} 绑定字段`} value={r.fieldKey||''} onChange={e=>onChange(regions.map((v,n)=>n===i?{...v,fieldKey:e.target.value||null}:v))}><option value="">不绑定（裁剪识别）</option>{fieldKeys.map(key=><option key={key} value={key}>{key}</option>)}</select></label><Button size="small" disabled={r.page===0&&!image} title={r.page===0&&!image?'请先选择样本并加载目标页面':undefined} onClick={()=>onChange(regions.map((v,n)=>n===i?{...v,page:v.page===0?previewPage:0}:v))}>{r.page===0?'仅当前预览页':'应用所有页'}</Button></div>)}
      {!!regions.length&&<div className="ocr-region-clear"><Button size="small" appearance="subtle" onClick={()=>setConfirmClear(v=>!v)}>{confirmClear?'取消清除':'清除全部区域'}</Button>{confirmClear&&<Button size="small" onClick={()=>{onChange([]);setConfirmClear(false);}}>确认清除 {regions.length} 个区域</Button>}</div>}
    </aside></div>
    <p className="ocr-policy">{regions.some(r=>r.fieldKey)?'已绑定字段：整页识别以保留上下文，绑定字段仅从指定区域取值。':regions.length?'仅裁剪识别已框选区域。绑定字段后，将整页识别以保留上下文。':'未设置区域时，识别通用设置中指定页面的全文。'} 换版式后请重新选择样本，核对区域位置。</p>
  </section>;
}
