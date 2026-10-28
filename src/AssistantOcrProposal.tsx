import { useState } from 'react';
import { Button } from '@fluentui/react-components';
import { SlidersHorizontal } from '@phosphor-icons/react';
import { api } from './api';
import { Modal } from './components';
import type { OcrProposal } from './types';
import type { OcrFieldDefinition, OcrProfile } from './ocrTypes';

const profileLabels:Partial<Record<keyof OcrProfile,string>>={name:'配置名称',keywords:'自动匹配关键词',pages:'提取页范围',dpi:'渲染 DPI',threshold:'匹配与复核阈值',filenamePattern:'命名格式',extraTitles:'附加标题',noiseMarkers:'排除词',extraHeaders:'补充表头'};
const fieldLabels:Record<keyof OcrFieldDefinition,string>={key:'字段名称',prompt:'Jev 判断要求',kind:'字段类型',multiple:'提取多个值',maxItems:'最多提取数量',separator:'多个值分隔符',required:'必须提取',fallback:'未找到时默认值',anchors:'本地定位词',pattern:'本地正则表达式',stripPrefixes:'清理前缀',format:'输出格式'};
const statuses={pending:'待你确认',applied:'已保存',rejected:'未应用',expired:'已失效，请重新生成'};
function value(input:unknown):string{
  if(input==null)return '无';
  if(typeof input==='boolean')return input?'是':'否';
  if(Array.isArray(input))return input.join('、')||'无';
  return String(input)||'无';
}
function Rows({rows}:{rows:{label:string;before:unknown;after:unknown}[]}){
  return <div className="markdown-table"><table><thead><tr><th>调整项目</th><th>当前</th><th>调整后</th></tr></thead><tbody>{rows.map(row=><tr key={row.label}><th>{row.label}</th><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value(row.before)}</td><td style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value(row.after)}</td></tr>)}</tbody></table></div>;
}
function OcrDiff({proposal:p}:{proposal:OcrProposal}){
  const keys=Object.keys(profileLabels) as (keyof OcrProfile)[];
  const rows=keys.filter(key=>JSON.stringify(p.before?.[key])!==JSON.stringify(p.after[key])).map(key=>({label:profileLabels[key]!,before:p.before?.[key],after:p.after[key]}));
  const names=[...new Set([...(p.before?.fields||[]),...p.after.fields].map(field=>field.key))];
  return <div className="proposal-diff">
    <div className="proposal-reason"><strong>调整原因</strong><p>{p.reason}</p></div>
    <p className="proposal-impact">预期影响：{p.impact}</p>
    {!!rows.length&&<Rows rows={rows}/>}
    {names.map(name=>{
      const before=p.before?.fields.find(field=>field.key===name),after=p.after.fields.find(field=>field.key===name);
      const keys=(Object.keys(fieldLabels) as (keyof OcrFieldDefinition)[]).filter(key=>key!=='key'&&JSON.stringify(before?.[key])!==JSON.stringify(after?.[key]));
      if(!keys.length)return null;
      return <details key={name}><summary>{!before?'新增':!after?'删除':'调整'}字段：{name}</summary><Rows rows={keys.map(key=>({label:fieldLabels[key],before:before?.[key],after:after?.[key]}))}/></details>;
    })}
    {!p.after.keywords.some(word=>word.trim())&&<p className="ocr-warning">未设置自动匹配关键词，保存后仅能手动选择此配置。</p>}
    {p.before&&p.after.threshold<p.before.threshold&&<p className="ocr-warning">阈值将降低，较低分文字也可能参与自动分类和字段提取，请核对是否符合你的需求。</p>}
    <p className="muted">画框和未列出的配置项保持不变。确认后仅保存这份配置，供后续任务使用；当前任务和原文件不变。方案保留 30 分钟，应用重启后需重新生成。</p>
  </div>;
}
export function AssistantOcrProposal({proposal,onResolved}:{proposal:OcrProposal;onResolved:(proposal:OcrProposal)=>void}){
  const [current,setCurrent]=useState(proposal),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function preview(){
    if(busy)return;setBusy(true);setError('');
    try{const next=await api<OcrProposal>('ocr_get_proposal',{id:current.id});setCurrent(next);onResolved(next);setOpen(true);}catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function decide(approve:boolean){
    if(busy)return;setBusy(true);setError('');
    try{const next=await api<OcrProposal>('ocr_decide_proposal',{id:current.id,approve});setCurrent(next);onResolved(next);setOpen(false);}catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <div className="assistant-proposal">
    <div className="assistant-proposal-heading"><SlidersHorizontal size={18}/><strong>OCR 配置{current.before?'调整':'新建'}方案 · {current.after.name}</strong><span role="status">{statuses[current.status]}</span></div>
    <p>{current.reason}</p>
    {current.status==='pending'&&<div className="assistant-proposal-actions"><Button size="small" appearance="primary" disabled={busy} onClick={()=>void preview()}>查看方案与差异</Button><Button size="small" disabled={busy} onClick={()=>void decide(false)}>不应用</Button></div>}
    {!open&&error&&<p className="inline-error" role="alert">{error}</p>}
    {open&&<Modal wide title="确认 OCR 配置方案" onClose={()=>{if(!busy)setOpen(false);}}>
      <OcrDiff proposal={current}/>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><span>{statuses[current.status]} · 保存不代表已验证识别效果</span><Button disabled={busy} onClick={()=>setOpen(false)}>返回</Button>{current.status==='pending'&&<><Button disabled={busy} onClick={()=>void decide(false)}>不应用</Button><Button disabled={busy} appearance="primary" onClick={()=>void decide(true)}>{busy?'正在保存…':'同意并保存配置'}</Button></>}</div>
    </Modal>}
  </div>;
}
