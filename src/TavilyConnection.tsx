import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { api, desktop } from './api';
import type { Settings } from './types';
import { KeyGuide } from './ServiceGuide';
import { useNetwork, type ServiceStatus } from './NetworkControls';

export function TavilyConnection({settings,onSaved,onDirtyChange,onBusyChange,disabled=false}:{settings:Settings;onSaved:(s:Settings)=>void;onDirtyChange?:(dirty:boolean)=>void;onBusyChange?:(busy:boolean)=>void;disabled?:boolean}){
  const {status:network}=useNetwork();const [status,setStatus]=useState<ServiceStatus|null>(null),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[removing,setRemoving]=useState(false);const running=useRef(false);
  const reload=useCallback(async()=>{if(desktop)setStatus(await api<ServiceStatus>('service_status'));},[]);
  useEffect(()=>{void reload().catch(e=>setError(String(e)));},[reload,settings.revision,network]);
  useEffect(()=>onDirtyChange?.(!!secret.trim()),[secret,onDirtyChange]);
  async function run(action:()=>Promise<void>){if(running.current||disabled)return;running.current=true;setBusy(true);onBusyChange?.(true);setError('');setMessage('');try{await action();await reload();}catch(e){setError(String(e));}finally{running.current=false;setBusy(false);onBusyChange?.(false);}}
  const unavailable=disabled||busy;
  return <section className="settings-section tavily-connection">
    <h3>Tavily 联网搜索</h3><p>AI 模型负责理解与回答，Tavily 负责查找公开互联网资料。两项需要分别配置。</p>
    <p role="status">模型：{status?.modelConfigured?'已配置':'未配置'} · 搜索：{!status?.tavilyKey?'未配置':!status.tavilyTestedAt?'已保存 Key，待测试':settings.tavilyEnabled?'已启用':'测试通过，待启用'}{status?.tavilyTestedAt?`（上次测试：${new Date(status.tavilyTestedAt*1000).toLocaleString()}）`:''}</p>
    <KeyGuide service="tavily" open={!status?.tavilyKey}/>
    <label className="model-secret">Tavily API Key<input type="password" autoComplete="new-password" disabled={unavailable} value={secret} onChange={e=>{setSecret(e.target.value);setError('');setMessage('');}} placeholder="tvly-…；留空测试已保存的 Tavily Key"/></label>
    <p className="muted">测试只向 Tavily 发送固定公开关键词“Microsoft WebView2”，可能消耗额度。新 Key 测试通过后才替换原 Key，测试不会自动启用搜索。</p>
    <div className="button-row"><Button type="button" disabled={unavailable||(!secret.trim()&&!status?.tavilyKey)} onClick={()=>void run(async()=>{const result=await api<{resultCount:number}>('tavily_test_connection',{secret:secret.trim()||null});setSecret('');setMessage(`连接成功，返回 ${result.resultCount} 条结果。${settings.tavilyEnabled?'搜索已启用。':'请点击“启用联网搜索”。'}`);})}>{busy?'正在处理（授权后请求最多 45 秒）…':secret.trim()?'测试并保存 Key':'测试已保存的 Key'}</Button>
    <Button type="button" appearance="primary" disabled={unavailable||!status?.tavilyTestedAt||!!secret.trim()||!!settings.tavilyEnabled} onClick={()=>void run(async()=>{const next=await api<Settings>('save_settings',{next:{...settings,tavilyEnabled:true}});onSaved(next);setMessage('Tavily 联网搜索已启用。首次实际搜索仍需确认数据范围。');})}>启用联网搜索</Button>
    {settings.tavilyEnabled&&<Button type="button" disabled={unavailable} onClick={()=>void run(async()=>{onSaved(await api<Settings>('save_settings',{next:{...settings,tavilyEnabled:false}}));setMessage('联网搜索已关闭。');})}>关闭搜索</Button>}
    {status?.tavilyKey&&<Button type="button" disabled={unavailable} onClick={()=>setRemoving(v=>!v)}>删除已保存的搜索 Key</Button>}
    </div>{!status?.modelConfigured&&<p className="muted">搜索服务可以独立测试；通过助手搜索并整理资料还需要完成模型配置。</p>}
    {removing&&<div className="setup-callout"><p>确认删除本机保存的 Tavily Key 并关闭搜索？后续需要重新填写。</p><div className="button-row"><Button type="button" disabled={unavailable} onClick={()=>void run(async()=>{await api('set_key',{provider:'tavily',secret:''});onSaved(await api<Settings>('save_settings',{next:{...settings,tavilyEnabled:false}}));setRemoving(false);setMessage('Tavily Key 已删除，搜索已关闭。');})}>确认删除</Button><Button type="button" disabled={unavailable} onClick={()=>setRemoving(false)}>取消</Button></div></div>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="inline-error">{error}</p>}
  </section>;
}
