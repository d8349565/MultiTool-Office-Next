import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Switch } from '@fluentui/react-components';
import { listen } from '@tauri-apps/api/event';
import { api, desktop } from './api';
import { Modal } from './components';
import './setup.css';

interface Grant {id:string;feature:string;label:string;service:string;categories:string[];masked:boolean}
interface Activity extends Grant {time:number;status:string}
interface NetworkStatus {localOnly:boolean;setupStep:number;setupDismissed:boolean;grants:Grant[];activities:Activity[];pending:{id:string;grant:Grant;expiresAt:number}[];notice?:string|null}
export interface ServiceStatus {modelKey:boolean;modelConfigured:boolean;tavilyKey:boolean;tavilyTestedAt:number|null;tavilyEnabled:boolean;jevKey:boolean}
const statusNames:Record<string,string>={running:'正在请求',success:'成功',failed:'失败',blocked:'已阻止',cancelled:'已停止',interrupted:'已中断'};
const NetworkContext=createContext<{status:NetworkStatus|null;error:string;refresh:()=>Promise<void>}>({status:null,error:'',refresh:async()=>{}});
export const useNetwork=()=>useContext(NetworkContext);
export const openSetup=()=>window.dispatchEvent(new Event('office-open-setup'));
export function NetworkProvider({children}:{children:ReactNode}){
  const [status,setStatus]=useState<NetworkStatus|null>(null),[error,setError]=useState('');
  const version=useRef(0);
  const refresh=useCallback(async()=>{if(!desktop)return;const current=++version.current;try{const next=await api<NetworkStatus>('network_status');if(current===version.current){setStatus(next);setError('');}}catch(e){if(current===version.current)setError(String(e));}},[]);
  useEffect(()=>{if(!desktop)return;let alive=true,timer:ReturnType<typeof setTimeout>|undefined;const stop=listen('network-updated',()=>{if(timer)return;timer=setTimeout(()=>{timer=undefined;if(alive)void refresh();},80);});void stop.then(()=>{if(alive)void refresh();});const poll=setInterval(()=>void refresh(),60000);return()=>{alive=false;version.current++;clearTimeout(timer);clearInterval(poll);void stop.then(fn=>fn());};},[refresh]);
  return <NetworkContext.Provider value={{status,error,refresh}}>{children}</NetworkContext.Provider>;
}
export function NetworkIndicator({onOpen}:{onOpen:()=>void}){
  const {status,error}=useNetwork();const active=status?.activities.filter(a=>a.status==='running')||[];
  return <button type="button" className={`network-indicator ${active.length?'is-online':''}`} onClick={onOpen} title={active.map(a=>`${a.label} → ${a.service}`).join('\n')||'查看联网权限与活动记录'}><span aria-hidden="true">●</span><span className="network-indicator-label">{error?'联网状态不可用':status?.localOnly?'仅本地模式':active.length?`联网中 · ${active[0].label}`:'本地处理'}</span></button>;
}
export function NetworkConsent(){
  const {status,refresh}=useNetwork(),selected=status?.pending[0];
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setError('');},[selected?.id]);
  useEffect(()=>{if(!selected)return;const timer=setInterval(()=>void refresh(),1000);return()=>clearInterval(timer);},[selected?.id,refresh]);
  async function decide(approve:boolean){if(!selected||busy)return;setBusy(true);setError('');try{await api('network_decide',{id:selected.id,approve});}catch(e){setError(String(e));}finally{setBusy(false);await refresh();}}
  if(!selected)return null;const grant=selected.grant;
  return <Modal title={`允许${grant.label}联网？`} className="network-consent" onClose={()=>{if(!busy)void decide(false);}}>
    <p>服务：<strong>{grant.service}</strong></p><p>此功能可能发送以下数据：</p><ul>{grant.categories.map(c=><li key={c}>{c}</li>)}</ul>
    <p>{grant.masked?'OCR 候选信息已过滤金额、长号码等敏感数字；不代表全部内容已匿名化。':'这些内容不适用 OCR 候选数字脱敏规则。'}</p>
    <p>对方服务按其政策处理数据；任务、聊天或结果可能在本机保留。活动记录仅保存数据类别等摘要，最长 30 天。</p>
    <p className="muted">同意后记住此功能与服务的授权。服务、账号或数据范围变化时重新确认。文件正文仍需逐文件确认；可随时在“隐私与联网”撤销授权。确认最长等待 90 秒，也受任务预算限制。</p>
    {grant.feature.endsWith('_test')&&<p>本次为连接测试，不发送业务资料，可能消耗服务额度。</p>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <footer className="dialog-actions"><Button type="button" disabled={busy} onClick={()=>void decide(false)}>暂不允许</Button><Button type="button" appearance="primary" disabled={busy} onClick={()=>void decide(true)}>同意此功能联网</Button></footer>
  </Modal>;
}
export function NetworkSettings(){
  const {status,error:loadError,refresh}=useNetwork();const [busy,setBusy]=useState(false),[error,setError]=useState(''),[clearing,setClearing]=useState(false),[limit,setLimit]=useState(50);
  async function act(command:string,args?:Record<string,unknown>){setBusy(true);setError('');try{await api(command,args);setClearing(false);await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <section className="settings-section network-settings">
    <h3>联网控制</h3>{status?.notice&&<p role="alert" className="inline-error">{status.notice}</p>}<Switch checked={!!status?.localOnly} disabled={busy||!status} label="仅本地模式" onChange={(_,v)=>void act('network_local_mode',{enabled:v.checked})}/>
    <p>开启后暂停应用内模型、Tavily、Jev 和连接测试，并停止正在进行的请求。本地检索、预览、OCR 继续可用。已经发送的内容无法通过此开关收回。</p>
    <h3>已授权的联网功能</h3>{!status?.grants.length&&<p className="muted">尚未授权。首次使用时会说明服务与数据范围。</p>}
    {status?.grants.map(g=><div className="network-grant" key={g.id}><div><strong>{g.label}</strong><span>{g.service}</span><small>{g.categories.join('；')}</small></div><Button type="button" disabled={busy} onClick={()=>void act('network_revoke',{id:g.id})}>撤销授权</Button></div>)}
    <div className="settings-budget-heading"><h3>联网活动</h3><Button type="button" disabled={busy} onClick={()=>setClearing(v=>!v)}>清空活动记录</Button></div>
    <p className="muted">保留最近 30 天、最多 1000 条。仅记录类别和结果，不额外保存正文、完整文件路径或 Key。已有聊天、OCR 任务和报告仍在各自入口管理。</p>
    {clearing&&<div className="setup-callout"><p>确认清空已结束的联网活动记录？正在请求的记录会保留。</p><Button type="button" disabled={busy} onClick={()=>void act('network_clear_activity')}>确认清空</Button><Button type="button" onClick={()=>setClearing(false)}>取消</Button></div>}
    <div className="network-activities">{status?.activities.slice(0,limit).map(a=><article key={a.id}><header><strong>{a.label}</strong><span>{statusNames[a.status]||a.status}</span></header><p>{a.service} · {new Date(a.time*1000).toLocaleString()}</p><small>{a.categories.join('；')} · {a.masked?'已执行候选数字过滤':'不适用 OCR 数字脱敏'}</small></article>)}{!status?.activities.length&&<p className="muted">还没有联网活动。</p>}</div>{(status?.activities.length||0)>limit&&<Button type="button" onClick={()=>setLimit(n=>n+50)}>再显示 50 条</Button>}
    {(error||loadError)&&<p role="alert" className="inline-error">{error||loadError}</p>}
  </section>;
}
