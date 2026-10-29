import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox } from '@fluentui/react-components';
import { api } from './api';
import { Modal } from './components';

interface Preview { binding:string;modelHost:string;modelId:string;content:string }
export interface OcrDiagnosticRequest extends Preview { id:string;question:string }
function ReadablePreview({content}:{content:string}){
  const packet=useMemo(()=>{try{return JSON.parse(content);}catch{return null;}},[content]);
  if(!packet||typeof packet!=='object')return <p className="inline-error">共享内容格式尚未完整，请核对编辑。</p>;
  const rows=(value:unknown)=>Array.isArray(value)?value.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[];
  const overview=packet.overview||{},fields=rows(packet.fields),lines=rows(packet.lines);
  const status=(value:unknown)=>(({completed:'已结束',ready:'已就绪',review:'需复核',failed:'失败',running:'正在处理',queued:'排队中',cancelled:'已取消',interrupted:'已中断'} as Record<string,string>)[String(value)]||'未记录');
  const text=(value:unknown)=>value===undefined||value===null?'未记录':typeof value==='object'?JSON.stringify(value):String(value);
  return <section className="ocr-diagnostic-readable" aria-label="共享内容阅读预览">
    <div className="ocr-form-grid"><p>文件状态：<strong>{status(overview.fileStatus)}</strong><br/>文字范围：{text(overview.sharedLineCount)} / {text(overview.ocrLineCount)} 行</p><p>识别配置：<strong>{text(packet.profiles?.atRecognition?.name)}</strong><br/>当前配置：{text(packet.profiles?.current?.name)}</p></div>
    {overview.profileChangedSinceRecognition===true&&<p className="ocr-warning">识别后配置已经变化，助理将对照两份配置分析。</p>}
    <details><summary>字段结果与来源（{fields.length} 项）</summary><ul>{fields.map((field:any,index:number)=><li key={index}><strong>{text(field.key)}</strong>：{text(field.result?.value)} · {field.result?.source==='jev'?'Jev 判断':field.result?.source==='local'?'本地提取':field.result?.source==='manual'?'人工修正':'未识别'}{field.result?.review?' · 需复核':''}</li>)}</ul></details>
    <details><summary>脱敏文字与行号（{lines.length} 行）</summary><pre>{lines.length?lines.map((line:any)=>`第 ${text(line.page)} 页 · 第 ${text(line.line)} 行：${text(line.text)}`).join('\n'):'未共享文字；助理将仅依据配置与状态分析。'}</pre></details>
    <details><summary>流程与决策记录</summary><pre>{JSON.stringify({overview:packet.overview,classification:packet.classification,decisions:packet.decisions,questions:packet.questions},null,2)}</pre></details>
  </section>;
}
export function OcrDiagnosticShare({taskId,fileId,onClose,onShare}:{taskId:string;fileId:string;onClose:()=>void;onShare:(request:OcrDiagnosticRequest)=>void}){
  const [includeText,setIncludeText]=useState(true),[preview,setPreview]=useState<Preview|null>(null),[content,setContent]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [question,setQuestion]=useState('请诊断这份 OCR 结果：结合识别时配置、当前配置、候选和决策记录，解释日期或产品名称为何遗漏。区分已证实的问题与推测，给出下一步；需要调整配置时先提交方案供我确认。');
  useEffect(()=>{
    let live=true;setLoading(true);setPreview(null);setContent('');setError('');
    void api<Preview>('ocr_diagnostic_preview',{taskId,fileId,includeText}).then(result=>{if(live){setPreview(result);setContent(result.content);}}).catch(e=>{if(live)setError(String(e));}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[taskId,fileId,includeText]);
  function share(){
    if(!preview||loading)return;
    try{const value=JSON.parse(content);if(!value||typeof value!=='object'||!value.overview||Array.isArray(value))throw new Error();}
    catch{setError('请保留有效 JSON 格式；可以把不想共享的文字值改成 [已隐藏]。');return;}
    if(new TextEncoder().encode(content).length>200_000){setError('共享内容超过 200 KB，请删除不需要的文字或关闭“包含脱敏文字”。');return;}
    onShare({...preview,content,id:crypto.randomUUID(),question:question.trim()||'请根据我确认共享的 OCR 诊断快照分析原因并提出建议。'});
  }
  return <Modal title="让助理诊断 · 共享预览" wide onClose={onClose} className="ocr-diagnostic-share">
    <p>仅共享你选中的这份识别结果。预览包含流程状态、识别时与当前配置、字段结果及复核记录。</p>
    <Checkbox label="包含脱敏文字、位置和候选，帮助定位漏识别" checked={includeText} disabled={loading} onChange={(_,data)=>setIncludeText(!!data.checked)}/>
    <p className="muted">自动处理常见身份、联系方式、金额及路径；日期、产品名称可能保留。请核对下方预览，仍有业务信息时可继续删除或替换。原文件、图片和原始日志不会共享。</p>
    <p className="ocr-diagnostic-destination">接收方：<strong>{preview?`${preview.modelId} · ${preview.modelHost}`:'正在核对当前模型…'}</strong></p>
    {loading&&<p role="status">正在生成本机脱敏预览，尚未发送给模型…</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {preview&&<><ReadablePreview content={content}/><details><summary>查看或编辑完整共享内容</summary><label className="ocr-field">可以把不想共享的文字值改成 [已隐藏]，保留引号和括号。<textarea className="ocr-diagnostic-preview" aria-label="诊断共享内容" value={content} onChange={e=>setContent(e.target.value)} spellCheck={false}/></label></details><label className="ocr-field">希望助理解决的问题<textarea rows={3} value={question} onChange={e=>setQuestion(e.target.value)}/></label></>}
    <p className="muted">确认后发送给上方模型并新建诊断会话。后续追问可继续读取这份快照，删除会话可清理本地共享记录。识别和改名仍需你在 OCR 页面执行，配置方案仍需单独确认。</p>
    <div className="dialog-actions"><Button onClick={onClose}>取消</Button><Button appearance="primary" disabled={loading||!preview||!content.trim()} onClick={share}>确认并让助理诊断</Button></div>
  </Modal>;
}
