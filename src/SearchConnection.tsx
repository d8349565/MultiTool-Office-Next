import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Switch } from '@fluentui/react-components';
import { api, desktop } from './api';
import type { Settings, ServiceUsage } from './types';
import { KeyGuide, OfficialLink } from './ServiceGuide';
import { useNetwork, type ServiceStatus } from './NetworkControls';
import { money } from './assistantPricing';
import { searchSettingsChanged, searchSettingsKeys } from './settingsDraft';
import defaults from './assistantPricingDefaults.json';

interface Props {
  settings:Settings;value:Settings;onChange:(changes:Partial<Settings>)=>void;onSaved:(s:Settings,keys?:readonly string[])=>void;
  onSecretDirtyChange?:(dirty:boolean)=>void;onSaveBlockedChange?:(reason:string)=>void;onBusyChange?:(busy:boolean)=>void;
  disabled?:boolean;standalone?:boolean;resetVersion?:number;
}
export function SearchConnection({settings,value,onChange,onSaved,onSecretDirtyChange,onSaveBlockedChange,onBusyChange,disabled=false,standalone=true,resetVersion=0}:Props){
  const {status:network}=useNetwork();
  // 配置草稿只由页面持有；这里仅保留尚未写入凭据管理器的 Key。
  const provider=value.searchProvider||'tavily',profileId=value.deepseekSearchProfileId||'',fetchEnabled=!!value.deepseekFetchEnabled;
  const [status,setStatus]=useState<ServiceStatus|null>(null),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[removing,setRemoving]=useState(false);
  const running=useRef(false),sequence=useRef(0);
  useEffect(()=>{setSecret('');setMessage('');setError('');setRemoving(false);},[resetVersion]);
  const reload=useCallback(async()=>{const request=++sequence.current;if(desktop){const next=await api<ServiceStatus>('service_status',{searchProvider:provider,profileId});if(sequence.current===request)setStatus(next);}},[provider,profileId]);
  useEffect(()=>{setStatus(null);setRemoving(false);setError('');setMessage('');void reload().catch(e=>setError(String(e)));return()=>{sequence.current++;};},[reload]);
  useEffect(()=>{void reload().catch(e=>setError(String(e)));},[reload,settings.revision,network]);
  const configurationDirty=searchSettingsChanged(value,settings),secretDirty=!!secret.trim();
  useEffect(()=>onSecretDirtyChange?.(secretDirty),[secretDirty,onSecretDirtyChange]);
  const selected=provider===(settings.searchProvider||'tavily')&&(provider!=='deepseek'||profileId===(settings.deepseekSearchProfileId||''));
  const matching=status?.searchProvider===provider&&(status.searchProfileId||'')===(provider==='deepseek'?profileId:'');
  const tested=matching?status?.searchTestedAt:null,hasKey=matching&&!!status?.searchKey;
  const needsTest=!settings.searchEnabled||!selected||(value.deepseekSearchProfileId??null)!==(settings.deepseekSearchProfileId??null)||(fetchEnabled&&!settings.deepseekFetchEnabled);
  const saveBlocked=secretDirty?'搜索密钥尚未保存，请先点击“测试并保存密钥”。':value.searchEnabled&&needsTest&&!tested?'请先测试所选搜索连接，再保存并启用；也可关闭“启用联网搜索”后仅保存配置。':'';
  useEffect(()=>onSaveBlockedChange?.(saveBlocked),[saveBlocked,onSaveBlockedChange]);
  async function run(action:()=>Promise<void>){if(running.current||disabled)return;running.current=true;setBusy(true);onBusyChange?.(true);setError('');setMessage('');try{await action();await reload();}catch(e){setError(String(e));await reload().catch(()=>{});}finally{running.current=false;setBusy(false);onBusyChange?.(false);}}
  const unavailable=disabled||busy,label=provider==='deepseek'?'DeepSeek':'Tavily',manual=provider==='tavily'||!profileId;
  const rates=settings.modelPricing?.toolRates??defaults.toolRates;
  const rateLabel=(operation:string)=>{const rate=rates.find(r=>r.operation===operation);return rate?`${rate.perThousand} ${rate.currency}/千次`:'未配置单价';};
  async function save(){onSaved(await api<Settings>('save_settings',{next:{...settings,...Object.fromEntries(searchSettingsKeys.map(key=>[key,value[key]]))}}),searchSettingsKeys);setMessage('搜索配置已保存。');}
  return <section className="settings-section search-connection">
    <div className="search-connection-heading"><div><h3>联网搜索</h3><p>选择公开资料搜索渠道，AI 模型负责理解与回答。</p></div><Switch disabled={unavailable} checked={!!value.searchEnabled} onChange={(_,v)=>onChange({searchEnabled:v.checked})} label="启用联网搜索"/></div>
    <div className="search-connection-status" role="status"><span>已保存：{settings.searchProvider==='deepseek'?'DeepSeek':'Tavily'} · {settings.searchEnabled?'已启用':'已关闭'}</span>{configurationDirty&&<span>以下配置有改动，{standalone?'保存搜索配置':'保存此模块'}后生效。</span>}</div>
    <div className="form-grid search-connection-fields">
      <label>搜索渠道<select disabled={unavailable||secretDirty} value={provider} onChange={e=>onChange({searchProvider:e.target.value as 'tavily'|'deepseek'})}><option value="tavily">Tavily</option><option value="deepseek">DeepSeek</option></select></label>
      {provider==='deepseek'&&<label>密钥来源<select disabled={unavailable||secretDirty} value={profileId} onChange={e=>onChange({deepseekSearchProfileId:e.target.value||null})}><option value="">单独填写搜索 API Key</option>{status?.deepseekProfiles.map(p=><option key={p.id} value={p.id}>复用：{p.name}</option>)}{profileId&&!status?.deepseekProfiles.some(p=>p.id===profileId)&&<option value={profileId}>已选模型配置（请确认配置可用）</option>}</select></label>}
    </div>
    {provider==='deepseek'&&profileId&&<p className="search-connection-hint">绑定所选 DeepSeek 模型配置，切换当前 AI 模型不影响搜索。模型 Key 变更后需重新测试搜索。</p>}
    {manual&&<div className="search-connection-key"><label className="model-secret">{label} API Key<input type="password" autoComplete="new-password" disabled={unavailable} value={secret} onChange={e=>{setSecret(e.target.value);setError('');setMessage('');}} placeholder={provider==='deepseek'?'sk-…；留空使用已保存的搜索 Key':'tvly-…；留空使用已保存的 Tavily Key'}/></label><KeyGuide service={provider==='deepseek'?'deepseek-search':'tavily'} open={!hasKey}/></div>}
    <div className="search-connection-test">
      <div className="button-row"><Button type="button" disabled={unavailable||(!secretDirty&&!hasKey)} onClick={()=>void run(async()=>{const result=await api<{resultCount:number;serviceUsage?:ServiceUsage[]}>('search_test_connection',{provider,profileId:provider==='deepseek'?(profileId||null):null,secret:secret.trim()||null});setSecret('');const bill=result.serviceUsage?.[0];setMessage(`搜索测试通过${secretDirty?'，密钥已保存':''}，返回 ${result.resultCount} 条结果。${bill?`本次测试费用：${bill.status==='calculated'&&bill.total!==undefined&&bill.currency?money(bill.total,bill.currency):'待核实'}。`:''}`);})}>{busy?'正在处理…':secretDirty?'测试并保存密钥':'测试搜索连接'}</Button>
        {manual&&hasKey&&<Button type="button" appearance="subtle" disabled={unavailable} onClick={()=>setRemoving(v=>!v)}>删除搜索 Key</Button>}
      </div>
      <p className="search-connection-hint" role="status">{!matching?'正在读取连接状态…':!hasKey?'请填写搜索 Key。':!tested?'所选连接待测试。':`搜索测试通过 · ${new Date(tested*1000).toLocaleString()}`}</p>
      <p className="search-connection-hint">测试仅发送公开关键词“Microsoft WebView2”，可能产生费用；授权后请求最多等待 45 秒。测试不会自动切换或启用搜索。</p>
    </div>
    {provider==='deepseek'&&<div className="search-connection-fetch"><Switch disabled={unavailable} checked={fetchEnabled} onChange={(_,v)=>onChange({deepseekFetchEnabled:v.checked})} label="允许额外抓取网页正文"/><p className="search-connection-hint">搜索已有正文时直接使用，没有时使用摘要。额外抓取默认关闭，开启并保存后按需调用并单独计费。</p><details className="search-connection-details"><summary>计费与使用说明</summary><p>当前计价：Search {rateLabel('search')}，Fetch {rateLabel('fetch')}。搜索附带正文不额外计次；单价可在“费用计价”中修改。</p><OfficialLink url="https://api-docs.deepseek.com/zh-cn/guides/search/">官方搜索、抓取与计费说明</OfficialLink></details></div>}
    {!status?.modelConfigured&&<p className="search-connection-hint">搜索可以独立测试；通过助手整理资料还需要完成 AI 模型配置。</p>}
    {removing&&<div className="setup-callout"><p>确认删除单独保存的 {label} 搜索 Key？{selected&&settings.searchEnabled?'当前搜索将关闭。':''}模型配置的 Key 会保留。</p><div className="button-row"><Button type="button" disabled={unavailable} onClick={()=>void run(async()=>{if(selected&&settings.searchEnabled)onSaved(await api<Settings>('save_settings',{next:{...settings,searchEnabled:false}}));await api('set_key',{provider:provider==='deepseek'?'deepseek-search':'tavily',secret:''});setRemoving(false);setMessage(`${label} 搜索 Key 已删除。`);})}>确认删除</Button><Button type="button" disabled={unavailable} onClick={()=>setRemoving(false)}>取消</Button></div></div>}
    {message&&<p role="status" className="search-connection-message">{message}</p>}{error&&<p role="alert" className="inline-error">{error}</p>}
    {standalone&&<><div className="button-row"><Button type="button" appearance="primary" disabled={unavailable||!configurationDirty||!!saveBlocked} onClick={()=>void run(save)}>保存搜索配置</Button></div>{configurationDirty&&saveBlocked&&<p role="status" className="search-connection-hint">{saveBlocked}</p>}</>}
  </section>;
}
